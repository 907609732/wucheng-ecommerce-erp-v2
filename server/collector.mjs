import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig, developmentConfig } from "./config.mjs";
const ops = new Set(["account", "prepare", "tasks", "submit", "download"]);
export async function startCollector(config, { factory, onError } = {}) {
  if (!factory)
    factory = async (id, dir) => {
      const entry = path.join(
        config.modules[id].root,
        "lib",
        id === "sales" ? "agent-cainiao-browser.mjs" : "cainiao-browser.mjs",
      );
      const { CainiaoBrowser } = await import(pathToFileURL(entry).href);
      return new CainiaoBrowser(dir);
    };
  const servers = [],
    browsers = [],
    records = [];
  let timer, failure, stopping;
  const publish = () => {
    for (const r of records) {
      const value = {
        schemaVersion: 1,
        pid: process.pid,
        url: r.url,
        token: r.token,
        at: Date.now(),
        state: r.browser.status(),
      };
      const tmp = r.file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(tmp, r.file);
    }
  };
  function stop() {
    if (stopping) return stopping;
    clearInterval(timer);
    stopping = (async () => {
      await Promise.all(browsers.map((b) => b.disconnect().catch(() => {})));
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      for (const r of records)
        try {
          if (JSON.parse(fs.readFileSync(r.file)).pid === process.pid)
            fs.unlinkSync(r.file);
        } catch {}
      for (const r of records)
        try { fs.unlinkSync(r.file + "." + process.pid + ".tmp"); } catch {}
    })();
    return stopping;
  }
  function publishSafely() {
    if (failure || stopping) return;
    try { publish(); }
    catch (error) {
      const code = /^E[A-Z0-9]{1,30}$/.test(error.code) ? error.code : "WRITE_FAILED";
      failure = new Error(`采集助手状态写入失败（${code}），已停止采集`);
      clearInterval(timer);
      console.error(failure.message);
      process.exitCode = 1;
      // An owner must drain module disconnect calls before closing this helper.
      // A standalone helper owns its own teardown. Never throw from the timer.
      void Promise.resolve().then(() => onError ? onError(failure) : stop()).catch(() => {
        console.error("采集助手故障清理失败");
      });
    }
  }
  try {
    for (const id of ["sales", "overview"]) {
      const dir = config.modules[id].dataDir;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, ".web-collector.json");
      if (fs.existsSync(file)) {
        const old = JSON.parse(fs.readFileSync(file));
        if (Date.now() - old.at < 6000)
          throw Error("此账本已有用户会话采集助手");
      }
      const browser = await factory(id, dir);
      browsers.push(browser);
      const token = randomBytes(32).toString("hex");
      let busy = false;
      const server = http.createServer(async (req, res) => {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        const send = (code, value) => {
          res.statusCode = code;
          res.end(JSON.stringify(value));
        };
        const auth = req.headers.authorization;
        if (
          req.method !== "POST" ||
          req.url !== "/" ||
          req.headers.origin ||
          !["127.0.0.1", "::ffff:127.0.0.1"].includes(
            req.socket.remoteAddress,
          ) ||
          typeof auth !== "string" ||
          auth.length !== 71 ||
          !timingSafeEqual(Buffer.from(auth), Buffer.from("Bearer " + token))
        )
          return send(401, { error: "采集助手身份无效" });
        if (busy)
          return send(409, { error: "采集助手正在操作浏览器，请稍后重试" });
        try {
          let bytes = 0;
          const chunks = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 65536) throw Error("采集请求过大");
            chunks.push(chunk);
          }
          const { action, args = {} } = JSON.parse(Buffer.concat(chunks));
          if (failure && action !== "disconnect") throw failure;
          if (
            ![
              "connect",
              "disconnect",
              "run",
              "rememberAuthorization",
              "forgetAuthorization",
            ].includes(action)
          )
            throw Error("采集操作无效");
          if (action === "run") {
            if (!ops.has(args.op)) throw Error("浏览器操作未登记");
            if (args.args?.target) {
              const target = path.resolve(args.args.target);
              if (
                path.dirname(target) !== path.resolve(browser.dir) ||
                !target.endsWith(".part")
              )
                throw Error("下载目录无效");
            }
            if (
              !Number.isInteger(args.timeout) ||
              args.timeout < 1000 ||
              args.timeout > 660000
            )
              throw Error("等待时间无效");
          }
          if (busy) throw Error("采集助手正在操作浏览器，请稍后重试");
          busy = true;
          let result;
          try {
            result =
              action === "run"
                ? await browser.run(args.op, args.args || {}, args.timeout)
                : action === "rememberAuthorization"
                  ? await browser.rememberAuthorization(args.token)
                  : await browser[action]();
          } finally {
            busy = false;
            publishSafely();
          }
          if (failure && action !== "disconnect") throw failure;
          send(200, { result: result ?? null });
        } catch (e) {
          send(409, { error: e.message });
        }
      });
      servers.push(server);
      await new Promise((r, j) =>
        server.once("error", j).listen(0, "127.0.0.1", r),
      );
      records.push({
        file,
        browser,
        token,
        url: "http://127.0.0.1:" + server.address().port + "/",
      });
    }
    publish();
    timer = setInterval(publishSafely, 1000);
    return { stop, status: () => ({ ok: !failure && !stopping, error: failure?.message }) };
  } catch (e) {
    await stop();
    throw e;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  delete process.env.LINGTU_WEB_COLLECTOR;
  const index = process.argv.indexOf("--config"),
    config =
      index >= 0 ? loadConfig(process.argv[index + 1]) : developmentConfig();
  startCollector(config)
    .then((helper) => {
      console.log("用户会话采集助手已启动；未自动登录或采集。");
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => helper.stop());
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
