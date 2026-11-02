import fs from "node:fs";
import path from "node:path";
import { ServiceManager } from "../desktop/shared/service-manager.mjs";
import { moduleIds, databases } from "./config.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
};
export async function createSourceServices(
  config,
  { Manager = ServiceManager } = {},
) {
  const registryFile = path.join(config.stateDir, "web-registry.json");
  fs.mkdirSync(config.stateDir, { recursive: true });
  const registry = {};
  for (const id of moduleIds) {
    const m = config.modules[id];
    const pkg = JSON.parse(
      fs.readFileSync(path.join(m.root, "package.json"), "utf8"),
    );
    if (!fs.existsSync(path.join(m.root, "node_modules", "express")))
      throw Error(id + " 缺少依赖，请执行 npm.cmd ci --prefix apps/" + id);
    registry[id] = {
      ...m,
      version: pkg.version,
      managed: true,
      allowInitialize:
        config.mode === "development" &&
        !fs.existsSync(path.join(m.dataDir, databases[id])),
      nodePath: process.execPath,
    };
  }
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  const manager = new Manager({
    registryFile,
    agentManaged: true,
    startupTimeoutMs: 30000,
    environment: { LINGTU_WEB_COLLECTOR: "1" },
  });
  manager.businessOnly = true;
  const ownershipFile = path.join(config.stateDir, "web-ownership.json");
  const ownership = fs.existsSync(ownershipFile)
    ? JSON.parse(fs.readFileSync(ownershipFile, "utf8"))
    : { schemaVersion: 1, modules: {} };
  if (
    ownership.schemaVersion !== 1 ||
    !ownership.modules ||
    Object.keys(ownership.modules).some((id) => !moduleIds.includes(id))
  )
    throw Error("网页服务进程归属记录无效");
  const saveOwnership = () => {
    const temp = ownershipFile + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(ownership), { mode: 0o600 });
    fs.renameSync(temp, ownershipFile);
  };
  const wanted = new Set(Object.keys(ownership.modules)),
    owned = new Map(),
    pendingStarts = new Set();
  let draining = false;
  const ensure = manager.ensure.bind(manager),
    configOf = manager.config.bind(manager);
  manager.config = (id) => {
    if (!moduleIds.includes(id)) throw Error("网页服务只允许三个业务台");
    return configOf(id);
  };
  manager.ensure = (id) => {
    const task = (async () => {
      if (draining) throw Error("网页服务正在维护，请稍后重试");
      const c = manager.config(id);
      let record = ownership.modules[id];
      if (!owned.has(id)) {
        const live = await manager.capabilities(id);
        if (draining) throw Error("网页服务正在维护，请稍后重试");
        if (live) {
          let lock;
          try {
            lock = JSON.parse(
              fs.readFileSync(
                path.join(c.dataDir, ".integration-start.lock"),
                "utf8",
              ),
            );
          } catch {}
          if (
            !record ||
            record.root !== c.root ||
            record.dataDir !== c.dataDir ||
            (record.hostPid !== process.pid && alive(record.hostPid)) ||
            (record.pid && record.pid !== live.pid) ||
            lock?.childPid !== live.pid ||
            lock?.ownerPid !== record.launchOwnerPid
          )
            throw Error(id + " 已由另一个进程运行，不能接管");
        } else
          record = {
            root: c.root,
            dataDir: c.dataDir,
            hostPid: process.pid,
            launchOwnerPid: process.pid,
          };
        ownership.modules[id] = { ...record, hostPid: process.pid };
        saveOwnership();
      }
      wanted.add(id);
      const cap = await ensure(id);
      owned.set(id, cap.pid);
      ownership.modules[id] = { ...ownership.modules[id], pid: cap.pid };
      saveOwnership();
      if (draining) throw Error("网页服务正在维护，请稍后重试");
      return cap;
    })();
    pendingStarts.add(task);
    task.then(
      () => pendingStarts.delete(task),
      () => pendingStarts.delete(task),
    );
    return task;
  };
  manager.webStatus = () => ({ draining, wanted: [...wanted] });
  // ServiceManager.stop normally calls ensure through request(). Maintenance
  // must never start a service, and must still be able to stop its owned child.
  manager.stop = async (id) => {
    const cap = await manager.capabilities(id);
    if (!cap) return { ok: true, alreadyStopped: true };
    if (cap.pid !== owned.get(id)) throw Error("模块进程已变化，不能停止");
    if (cap.busy) throw Error("模块仍有活动任务");
    const key = fs
      .readFileSync(
        path.join(manager.config(id).dataDir, ".integration-key"),
        "utf8",
      )
      .trim();
    const r = await fetch(cap.url + "/api/integration/v1/stop", {
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirm: true }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await r.json();
    if (!r.ok) throw Error(result.error || "停止失败");
    return result;
  };
  manager.drain = () => {
    draining = true;
  };
  manager.resume = () => {
    draining = false;
  };
  manager.restart = async (id) => {
    const cap = await manager.capabilities(id);
    if (cap?.busy) return false;
    if (cap && cap.pid !== owned.get(id))
      throw Error("模块进程已变化，不能停止");
    if (cap) {
      await manager.stop(id);
      for (
        let i = 0;
        i < 100 && ((await manager.capabilities(id)) || alive(cap.pid));
        i++
      )
        await sleep(50);
      if ((await manager.capabilities(id)) || alive(cap.pid))
        throw Error("旧服务未退出");
    }
    owned.delete(id);
    delete ownership.modules[id];
    saveOwnership();
    await manager.ensure(id);
    return true;
  };
  manager.supervise = async () => {
    if (draining) return;
    for (const id of wanted)
      try {
        if (!owned.has(id) || !(await manager.capabilities(id))) {
          owned.delete(id);
          await manager.ensure(id);
        }
      } catch (e) {
        manager.errors.set(id, e.message);
      }
  };
  manager.stopOwned = async () => {
    draining = true;
    await Promise.allSettled([...pendingStarts]);
    const errors = [];
    for (const id of Object.keys(ownership.modules))
      if (!owned.has(id)) {
        try {
          const lock = JSON.parse(
            fs.readFileSync(
              path.join(manager.config(id).dataDir, ".integration-start.lock"),
              "utf8",
            ),
          );
          if (lock.childPid && alive(lock.childPid))
            errors.push(id + ": 启动进程尚未就绪，不能进入备份窗口");
        } catch {}
      }
    for (const [id, pid] of owned)
      try {
        const cap = await manager.capabilities(id);
        if (cap) {
          if (cap.pid !== pid) throw Error("进程身份已变化");
          await manager.stop(id);
          for (
            let i = 0;
            i < 100 && ((await manager.capabilities(id)) || alive(pid));
            i++
          )
            await sleep(50);
          if ((await manager.capabilities(id)) || alive(pid))
            throw Error("服务未退出");
        }
      } catch (e) {
        errors.push(id + ": " + e.message);
      }
    if (errors.length) throw Error(errors.join("；"));
    owned.clear();
    wanted.clear();
    ownership.modules = {};
    saveOwnership();
  };
  return manager;
}
