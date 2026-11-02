import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { developmentConfig } from "../server/config.mjs";
import { createWebRuntime } from "../server/runtime.mjs";
import { control } from "../server/control.mjs";
async function ports() {
  for (let p = 30500; p < 40000; p += 5) {
    const servers = [];
    try {
      for (let n = 0; n < 5; n++) {
        const s = net.createServer();
        servers.push(s);
        await new Promise((r, j) =>
          s.once("error", j).listen(p + n, "127.0.0.1", r),
        );
      }
      return p;
    } catch {
    } finally {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    }
  }
  throw Error("ports unavailable");
}
test("real source services run without Electron, proxy UI/API and stop cleanly", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-web-runtime-")),
    config = developmentConfig({ stateDir: dir, port: await ports() });
  const runtime = await createWebRuntime(config, {
    watch: false,
    superviseMs: 200,
  });
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    fs.existsSync(
      path.join(config.modules.purchase.dataDir, "purchases.sqlite"),
    ),
    false,
    "host startup must not load business stores before a module is opened",
  );
  await runtime.start();
  const g = runtime.gateway;
  const session = await g.app.inject({
    url: "/api/workbench/v1/session",
    headers: { host: new URL(config.publicOrigin).host },
  });
  assert.equal(session.statusCode, 200, session.body);
  assert.deepEqual(
    session.json().modules.map((m) => m.status),
    ["stopped", "stopped", "stopped"],
  );
  const headers = {
    host: new URL(config.publicOrigin).host,
    cookie: session.headers["set-cookie"].split(";")[0],
  };
  for (const id of ["purchase", "sales", "overview"]) {
    const page = await g.app.inject({ url: `/apps/${id}/`, headers });
    assert.equal(page.statusCode, 200, page.body.slice(0, 300));
    assert.match(page.body, new RegExp(`/apps/${id}/workbench-base.js`));
    const boot = await g.app.inject({
      url: `/apps/${id}/api/bootstrap`,
      headers,
    });
    assert.equal(boot.statusCode, 200, boot.body);
    assert(!boot.body.includes(dir));
  }
  const cap = await runtime.services.capabilities("sales");
  assert.equal(cap.root, config.modules.sales.root);
  process.kill(cap.pid);
  await new Promise((r) => setTimeout(r, 1500));
  assert((await runtime.services.ensure("sales")).pid !== cap.pid);
  const shell = await g.app.inject({ url: "/", headers });
  assert.equal(shell.statusCode, 200);
  assert.match(shell.body, /iframe/);
  const blocked = await g.app.inject({ url: "/apps/warehouse/", headers });
  assert.equal(blocked.statusCode, 404);
  const before = await runtime.services.capabilities("purchase");
  assert(before.pid);
  assert.equal((await control(dir, "verify")).modules.length, 3);
  await control(dir, "quiesce");
  assert.equal(runtime.services.webStatus().draining, true);
  assert.equal(
    (
      await g.app.inject({
        url: "/apps/sales/api/ledger",
        method: "POST",
        headers,
      })
    ).statusCode,
    503,
  );
  await runtime.stop();
  assert.equal(await runtime.services.capabilities("purchase"), null);
});
