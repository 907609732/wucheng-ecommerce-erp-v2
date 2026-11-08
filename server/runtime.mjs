import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWorkbenchGateway } from "./gateway/gateway.mjs";
import { validateConfig, moduleIds } from "./config.mjs";
import { createSourceServices } from "./services.mjs";
import { controlEndpoint } from "./control.mjs";
import { verifyServices } from "./readiness.mjs";
import { createDataVersionWorker } from "./data-version/worker.mjs";
import { registerDataVersionRoutes } from "./data-version/routes.mjs";
import { createLogger } from "./log.mjs";
const publicDir = path.join(import.meta.dirname, "public");
const assetVersion = () =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(publicDir, "shell.js")))
    .update(fs.readFileSync(path.join(publicDir, "shell.css")))
    .update(fs.readFileSync(path.join(publicDir, "tokens.css")))
    .update(fs.readFileSync(path.join(publicDir, "data-versions.js")))
    .update(fs.readFileSync(path.join(publicDir, "data-versions.css")))
    .digest("hex")
    .slice(0, 16);
export async function createWebRuntime(
  input,
  {
    watch = input.mode === "development",
    superviseMs = 3000,
    providedLogger = null,
    logLevel,
    logFile,
  } = {},
) {
  const config = validateConfig(input);
  const logger =
    providedLogger ||
    createLogger({
      level: logLevel || process.env.ERP_LOG_LEVEL || "info",
      file: logFile || path.join(config.stateDir, "logs", "web.log"),
      scope: "host",
    });
  let gateway,
    services,
    timer,
    versionTimer,
    dataVersions,
    stopped = false,
    supervising = false;
  const watchers = [],
    pending = new Set(),
    activeWrites = new Set();
  // The OS releases this lock on crash. One data namespace has one owner.
  const token = randomBytes(32).toString("hex");
  const lock = net.createServer();
  const endpoint = controlEndpoint(config.stateDir);
  fs.mkdirSync(config.stateDir, { recursive: true });
  await new Promise((resolve, reject) => {
    lock.once("error", reject);
    lock.listen(endpoint, resolve);
  });
  try {
    logger.info("网页服务配置", {
      mode: config.mode,
      origin: config.publicOrigin,
      port: config.port,
      stateDir: config.stateDir,
      releaseRoot: config.releaseRoot || path.resolve(import.meta.dirname, ".."),
      node: process.version,
      pid: process.pid,
    });
    for (const id of moduleIds)
      logger.info("模块配置", {
        module: id,
        port: config.modules[id].port,
        dataDir: config.modules[id].dataDir,
        root: config.modules[id].root,
      });
    dataVersions = createDataVersionWorker({config});
    services = await createSourceServices(config, { logger });
    gateway = await createWorkbenchGateway({
      services,
      logger,
      storeDir: path.join(config.stateDir, "gateway"),
      publicOrigin: config.publicOrigin,
      port: config.port,
      moduleIds,
      cacheStaticAssets: config.mode === "production",
      localDevelopment: config.mode === "development",
      registerRoutes: async (app, context) => {
        registerDataVersionRoutes(app, context, dataVersions);
        app.addHook("onRequest", async (req, reply) => {
          if (!["GET", "HEAD"].includes(req.method)) {
            if (services.webStatus().draining)
              return reply
                .code(503)
                .send({
                  error: "服务正在维护，请稍后重试",
                  code: "WEB_MAINTENANCE",
                });
            activeWrites.add(req.id);
          }
        });
        app.addHook("onResponse", async (req) => {
          activeWrites.delete(req.id);
        });
        app.addHook("onRequestAbort", async (req) => {
          activeWrites.delete(req.id);
        });
        app.addHook("onTimeout", async (req) => {
          activeWrites.delete(req.id);
        });
        app.get("/", async (_q, r) =>
          r
            .header("cache-control", "no-store")
            .header(
              "content-security-policy",
              "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'",
            )
            .type("text/html")
            .send(
              fs
                .readFileSync(path.join(publicDir, "index.html"), "utf8")
                .replaceAll(
                  "/web/shell.css",
                  "/web/shell.css?v=" + assetVersion(),
                )
                .replaceAll(
                  "/web/tokens.css",
                  "/web/tokens.css?v=" + assetVersion(),
                )
                .replaceAll(
                  "/web/shell.js",
                  "/web/shell.js?v=" + assetVersion(),
                ),
            ),
        );
        for (const [name, type] of [
          ["shell.js", "text/javascript"],
          ["shell.css", "text/css"],
          ["tokens.css", "text/css"],
          ["data-versions.html", "text/html"],
          ["data-versions.js", "text/javascript"],
          ["data-versions.css", "text/css"],
        ])
          app.get("/web/" + name, async (q, r) => {
            const bytes = fs.readFileSync(path.join(publicDir, name)),
              etag =
                '"' + createHash("sha256").update(bytes).digest("hex") + '"';
            r.header(
              "cache-control",
              config.mode === "development"
                ? "no-store"
                : q.query.v === assetVersion()
                  ? "private, max-age=31536000, immutable"
                  : "private, no-cache",
            )
              .header("etag", etag)
              .type(type);
            if (q.headers["if-none-match"] === etag) return r.code(304).send();
            return r.send(bytes);
          });
      },
    });
  } catch (e) {
    logger.error("网页服务启动失败：" + e.message, { code: e.code });
    await dataVersions?.close();
    await services?.stopOwned().catch(() => {});
    await new Promise((r) => lock.close(r));
    throw e;
  }
  let quiescing;
  const runtime = {
    config,
    services,
    gateway,
    dataVersions,
    logger,
    async quiesce() {
      if (quiescing) return quiescing;
      quiescing = (async () => {
        logger.info("维护窗口：暂停受理新的写入请求");
        services.drain();
        const deadline = Date.now() + 60000;
        while (supervising) await new Promise((r) => setTimeout(r, 50));
        while (true) {
          const caps = await Promise.all(
            moduleIds.map((id) => services.capabilities(id)),
          );
          if (!activeWrites.size && !caps.some((c) => c?.busy)) break;
          if (Date.now() > deadline) {
            services.resume();
            throw Error("仍有采集或写入任务，请完成任务后更新");
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        await services.stopOwned();
        logger.info("维护窗口：全部模块已停止");
        return { ok: true };
      })().catch((e) => {
        quiescing = null;
        services.resume();
        logger.error("维护窗口失败：" + e.message);
        throw e;
      });
      return quiescing;
    },
    async start() {
      await gateway.start();
      logger.info("网页服务已启动", {
        url: config.publicOrigin,
        pid: process.pid,
      });
      fs.writeFileSync(
        path.join(config.stateDir, "web-control.json"),
        JSON.stringify({ token }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(config.stateDir, "web-runtime.json"),
        JSON.stringify({
          pid: process.pid,
          releaseRoot: path.resolve(import.meta.dirname, ".."),
          mode: config.mode,
          publicOrigin: config.publicOrigin,
          port: config.port,
          startedAt: new Date().toISOString(),
        }),
      );
      timer = setInterval(async () => {
        if (supervising || stopped) return;
        supervising = true;
        try {
          for (const id of pending) {
            if (await services.restart(id)) pending.delete(id);
          }
          await services.supervise();
        } catch (e) {
          logger.error("网页服务恢复失败：" + e.message);
        } finally {
          supervising = false;
        }
      }, superviseMs);
      timer.unref();
      if(config.dataVersion?.enabled && config.dataVersion.uploadMode!=='user-agent'){
        let lastVersionError = 0;
        const upload=()=>dataVersions.tick().catch(e=>{
          // Retried every five seconds; keep the console readable by logging once a minute.
          if(Date.now()-lastVersionError<60000)return;
          lastVersionError=Date.now();
          logger.error('数据版本上传暂不可用，将自动重试：'+e.message);
        });
        versionTimer=setInterval(upload,5000);
        versionTimer.unref();
        void upload();
      }
      if (watch)
        for (const id of moduleIds) {
          const root = config.modules[id].root;
          for (const target of [
            path.join(root, "lib"),
            path.join(root, "server.mjs"),
          ])
            watchers.push(
              fs.watch(
                target,
                { recursive: fs.statSync(target).isDirectory() },
                () => {
                  if (services.webStatus().wanted.includes(id)) pending.add(id);
                },
              ),
            );
        }
      return config.publicOrigin;
    },
    async stop() {
      if (stopped) return;
      logger.info("网页服务正在停止");
      clearInterval(timer);
      clearInterval(versionTimer);
      for (const w of watchers) w.close();
      await runtime.quiesce();
      await gateway.stop();
      await dataVersions.close();
      stopped = true;
      for (const name of ["web-runtime.json", "web-control.json"])
        fs.rmSync(path.join(config.stateDir, name), { force: true });
      await new Promise((r) => lock.close(r));
      logger.info("网页服务已停止");
      logger.close();
    },
  };
  lock.on("connection", (socket) => {
    let buffer = "",
      handled = false;
    socket.setTimeout(70000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > 1024) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      handled = true;
      try {
        const r = JSON.parse(buffer.split("\n")[0]);
        if (
          typeof r.token !== "string" ||
          r.token.length !== token.length ||
          !timingSafeEqual(Buffer.from(r.token), Buffer.from(token))
        )
          throw Error("主机控制身份无效");
        if (!["quiesce", "shutdown", "verify"].includes(r.action))
          throw Error("主机控制操作无效");
        const result =
          r.action === "verify"
            ? await verifyServices(services)
            : await runtime.quiesce();
        socket.end(JSON.stringify(result) + "\n", () => {
          socket.destroy();
          if (r.action === "shutdown")
            setImmediate(() =>
              runtime.stop().catch((e) => console.error(e.message)),
            );
        });
      } catch (e) {
        socket.end(JSON.stringify({ ok: false, error: e.message }) + "\n");
      }
    });
  });
  return runtime;
}
