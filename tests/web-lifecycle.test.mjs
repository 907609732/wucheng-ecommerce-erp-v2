import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { ServiceManager } from "../server/service-manager.mjs";
import { createSourceServices } from "../server/services.mjs";
import { developmentConfig } from "../server/config.mjs";
// Windows may reserve otherwise unused TCP ports after VPN/service changes.
async function availablePortBlock() {
  for (let port = 41050; port < 50000; port += 5) {
    const sockets = [];
    try {
      for (let i = 0; i < 5; i++) {
        const socket = net.createServer();
        sockets.push(socket);
        await new Promise((resolve, reject) =>
          socket.once("error", reject).listen(port + i, "127.0.0.1", resolve));
      }
      return port;
    } catch {
    } finally {
      await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve))));
    }
  }
  throw Error("No available isolated test port block");
}
test("drain waits for an in-flight first start and leaves no child running", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-drain-"));
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (entered = r));
  class DelayedManager extends ServiceManager {
    async start(id) {
      entered();
      await gate;
      return super.start(id);
    }
  }
  const config = developmentConfig({ stateDir: dir, port: await availablePortBlock() }),
    services = await createSourceServices(config, { Manager: DelayedManager });
  try {
    assert(
      services instanceof DelayedManager,
      "must use supplied manager for controlled delayed start",
    );
    const startup = services.ensure("sales");
    await started;
    let stopped = false;
    const stopping = services.stopOwned().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(stopped, false);
    release();
    await startup.catch(() => {});
    await stopping;
    assert.equal(await services.capabilities("sales"), null);
  } finally {
    release();
    await services.stopOwned();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("a restarted host recovers only a verified child belonging to its persisted namespace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-recover-")),
    config = developmentConfig({ stateDir: dir, port: await availablePortBlock() });
  const first = await createSourceServices(config);
  let next;
  try {
    const cap = await first.ensure("sales");
    const file = path.join(dir, "web-ownership.json");
    const ownership = JSON.parse(fs.readFileSync(file));
    ownership.modules.sales.hostPid = 2147483647;
    ownership.modules.sales.launchOwnerPid = 2147483647;
    fs.writeFileSync(file, JSON.stringify(ownership));
    const lockFile = path.join(
        config.modules.sales.dataDir,
        ".integration-start.lock",
      ),
      lock = JSON.parse(fs.readFileSync(lockFile));
    lock.ownerPid = 2147483647;
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    next = await createSourceServices(config);
    assert.equal((await next.ensure("sales")).pid, cap.pid);
    await next.stopOwned();
    assert.equal(await next.capabilities("sales"), null);
  } finally {
    await (next || first).stopOwned();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("进程归属记录只在内容变化时重写，避免每个资源请求都改同一个文件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-ownership-")),
    config = developmentConfig({ stateDir: dir, port: await availablePortBlock() }),
    services = await createSourceServices(config);
  try {
    const cap = await services.ensure("sales");
    const file = path.join(dir, "web-ownership.json");
    const first = fs.statSync(file);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).modules.sales.pid, cap.pid);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // A second request for the same desk must not touch the file at all.
    await services.ensure("sales");
    await services.ensure("sales");
    const second = fs.statSync(file);
    assert.equal(second.mtimeMs, first.mtimeMs);
    assert.equal(second.size, first.size);
  } finally {
    await services.stopOwned();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("归属记录写入失败只记日志，不让业务台启动失败", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-ownership-fail-")),
    config = developmentConfig({ stateDir: dir, port: await availablePortBlock() }),
    services = await createSourceServices(config);
  const file = path.join(dir, "web-ownership.json");
  try {
    // A directory at the target path makes every rename fail (EPERM/EISDIR).
    fs.rmSync(file, { recursive: true, force: true });
    fs.mkdirSync(file);
    const cap = await services.ensure("sales");
    assert.ok(cap?.url, "写入失败不应阻止业务台启动");
    assert.ok(await services.capabilities("sales"), "业务台应保持可访问");
    // Recovery: once the path is writable again the next request persists it.
    fs.rmSync(file, { recursive: true, force: true });
    await services.ensure("sales");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).modules.sales.pid, cap.pid);
  } finally {
    await services.stopOwned();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
