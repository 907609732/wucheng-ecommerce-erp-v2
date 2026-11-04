import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { developmentConfig, loadConfig, moduleIds } from "./config.mjs";
import { createWebRuntime } from "./runtime.mjs";
import { control } from "./control.mjs";
import { snapshotData, restoreSnapshot, verifySnapshot } from "./backup.mjs";
import { switchRelease } from "./update.mjs";
import { verifyRelease } from "./release.mjs";
import { validateUpgrade } from "./upgrade-check.mjs";
const root = path.resolve(import.meta.dirname, ".."),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw Error("参数必须为 --名称 值");
    const name = argv[i].slice(2);
    if (name === "debug") {
      options.debug = true;
      continue;
    }
    if (!argv[i + 1] || argv[i + 1].startsWith("--"))
      throw Error("参数必须为 --名称 值");
    if (
      !["config", "candidate", "output", "backup", "target", "log-level"].includes(
        name,
      )
    )
      throw Error("未知参数：" + name);
    options[name] = argv[++i];
  }
  return options;
}
function atomic(file, value) {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
export function checkSource(folder) {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw Error("需要系统 Node.js 24 或更新版本");
  for (const file of [
    "server/cli.mjs",
    ...moduleIds.map((id) => "apps/" + id + "/server.mjs"),
  ]) {
    const r = spawnSync(
      process.execPath,
      ["--check", path.join(folder, file)],
      { encoding: "utf8", windowsHide: true },
    );
    if (r.status !== 0) throw Error(file + " 语法检查失败：" + r.stderr);
  }
  for (const name of ["fastify", "@fastify/cookie", "@fastify/reply-from"])
    if (!fs.existsSync(path.join(folder, "node_modules", name)))
      throw Error("网页宿主缺少依赖：" + name);
  for (const id of moduleIds)
    if (
      !fs.existsSync(path.join(folder, "apps", id, "node_modules", "express"))
    )
      throw Error(id + " 缺少依赖");
  return { ok: true, node: process.version, modules: moduleIds };
}
async function health(config) {
  const r = await fetch(
    `http://127.0.0.1:${config.port}/api/workbench/v1/health`,
    { signal: AbortSignal.timeout(3000) },
  );
  if (!r.ok) throw Error("主机健康检查失败");
  return r.json();
}
async function waitHealthy(config) {
  let error;
  for (let i = 0; i < 60; i++) {
    try {
      return await health(config);
    } catch (e) {
      error = e;
      await sleep(250);
    }
  }
  throw error;
}
async function waitStopped(config) {
  for (let i = 0; i < 60; i++) {
    try {
      await health(config);
      await sleep(100);
    } catch {
      return;
    }
  }
  throw Error("旧网页服务未退出");
}
async function stop(config) {
  try {
    await health(config);
  } catch {
    return;
  }
  await control(
    config.stateDir,
    config.windowsService ? "quiesce" : "shutdown",
  );
  if (config.windowsService) serviceCommand(config, "stop");
  await waitStopped(config);
}
function serviceCommand(config, action) {
  const r = spawnSync(
    config.windowsService.wrapper,
      [action],
    { encoding: "utf8", windowsHide: true, timeout: 100000 },
  );
  if (r.status !== 0)
    throw Error("WinSW " + action + " 失败：" + (r.stderr || r.stdout));
}
function startDetached(configFile, folder) {
  const config = loadConfig(configFile);
  if (config.windowsService) {
    serviceCommand(config, "start");
    return;
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  const log = fs.openSync(path.join(config.stateDir, "web-service.log"), "a");
  try {
    const child = spawn(
      process.execPath,
      [path.join(folder, "server", "cli.mjs"), "start", "--config", configFile],
      {
        cwd: folder,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      },
    );
    child.on("error", (e) => console.error(e.message));
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
export function resolveCommandConfig(command, file) {
  const config = file ? loadConfig(file) :
    ["dev", "status"].includes(command) ? developmentConfig() : loadConfig(file);
  if (command === "dev" && config.mode !== "development")
    throw Error("开发启动必须使用 development 隔离配置，不能连接正式账本");
  return config;
}
export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "dev",
    o = args(argv.slice(1)),
    file = o.config || process.env.ERP_WEB_CONFIG;
  if (command === "check") return checkSource(root);
  if (command === "verify-backup") return verifySnapshot(o.backup);
  if (command === "restore-copy") {
    if (!o.backup || !o.target) throw Error("需要 --backup 和 --target");
    return restoreSnapshot(o.backup, path.resolve(o.target));
  }
  const config = resolveCommandConfig(command, file);
  if (command === "status") {
    let runtime;
    try {
      runtime = await health(config);
    } catch (e) {
      return {
        ok: false,
        status: "stopped",
        mode: config.mode,
        publicOrigin: config.publicOrigin,
        error: e.message,
      };
    }
    return {
      ok: true,
      status: "running",
      mode: config.mode,
      publicOrigin: config.publicOrigin,
      ...runtime,
    };
  }
  if (command === "stop") {
    await stop(config);
    return { ok: true, status: "stopped" };
  }
  if (command === "shutdown") {
    await control(config.stateDir, "shutdown");
    await waitStopped(config);
    return { ok: true, status: "stopped" };
  }
  if (command === "backup") {
    if (!o.output) throw Error("需要 --output 指定新备份目录");
    let live = false;
    try {
      await health(config);
      live = true;
    } catch {}
    if (live) await control(config.stateDir, "quiesce");
    try {
      return await snapshotData(config, path.resolve(o.output));
    } finally {
      if (live) {
        await stop(config);
        startDetached(file, root);
        await waitHealthy(config);
      }
    }
  }
  if (command === "update") {
    if (!file || !o.candidate) throw Error("需要 --config 与 --candidate");
    const candidateRoot = fs.realpathSync(o.candidate);
    verifyRelease(candidateRoot);
    const current = structuredClone(config),
      candidate = {
        ...config,
        releaseRoot: candidateRoot,
        modules: Object.fromEntries(
          moduleIds.map((id) => [
            id,
            {
              ...config.modules[id],
              root: path.join(candidateRoot, "apps", id),
            },
          ]),
        ),
      };
    return switchRelease({
      current,
      candidate,
      check: async () => checkSource(candidateRoot),
      stop: () => stop(config),
      snapshot: () =>
        snapshotData(
          config,
          path.join(config.stateDir, "backups", "before-update-" + Date.now()),
        ),
      preflight: (backup) =>
        validateUpgrade(
          current.releaseRoot || root,
          candidateRoot,
          backup.target,
        ),
      write: async (c) => atomic(file, c),
      start: async (c) => {
        startDetached(file, c.releaseRoot || root);
        await waitHealthy(c);
      },
      health: async (c) => {
        await waitHealthy(c);
        await control(c.stateDir, "verify");
        const record = JSON.parse(
          fs.readFileSync(path.join(c.stateDir, "web-runtime.json"), "utf8"),
        );
        if (
          path.resolve(record.releaseRoot) !==
          path.resolve(c.releaseRoot || root)
        )
          throw Error("运行版本目录不符");
      },
    });
  }
  if (!["start", "dev"].includes(command))
    throw Error("未知网页命令：" + command);
  if (command === "start" && config.mode !== "production")
    throw Error("正式启动必须使用 production 配置；开发使用 web:dev");
  if (command === "start") {
    verifyRelease(config.releaseRoot);
    if (path.resolve(config.releaseRoot) !== root) {
      const release = await import(
        pathToFileURL(path.join(config.releaseRoot, "server", "cli.mjs")).href
      );
      return release.main(["start", "--config", file]);
    }
  }
  checkSource(root);
  const logLevel = o["log-level"] || (o.debug ? "debug" : undefined);
  const logFile = file
    ? path.join(path.dirname(path.resolve(file)), "logs", "web.log")
    : undefined;
  const runtime = await createWebRuntime(config, { logLevel, logFile });
  try {
    await runtime.start();
  } catch (e) {
    await runtime.stop();
    throw e;
  }
  const logger = runtime.logger;
  logger?.info("访问地址 " + config.publicOrigin);
  logger?.info("日志文件 " + logger.file + "（级别 " + logger.level + "）");
  console.log(
    JSON.stringify({
      ok: true,
      url: config.publicOrigin,
      mode: config.mode,
      message:
        config.mode === "development"
          ? "开发隔离账本，不是正式数据"
          : "网页服务已启动",
    }),
  );
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      try {
        await runtime.stop();
      } catch (e) {
        closing = false;
        console.error(e.message);
      }
    });
  return undefined;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main()
    .then((r) => {
      if (r) console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
