import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ServiceManager } from "../server/service-manager.mjs";
import { createSourceServices } from "../server/services.mjs";
import { developmentConfig } from "../server/config.mjs";
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
  const config = developmentConfig({ stateDir: dir, port: 41050 }),
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
    config = developmentConfig({ stateDir: dir, port: 41055 });
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
