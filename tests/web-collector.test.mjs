import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCollector } from "../server/collector.mjs";
import { CollectorBrowser } from "../server/collector-client.mjs";
test("user-session collector authenticates local callers and only permits fixed browser operations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-collector-"));
  const modules = Object.fromEntries(
    ["sales", "overview"].map((id) => [
      id,
      { dataDir: path.join(dir, id), root: dir },
    ]),
  );
  let calls = 0;
  const helper = await startCollector(
    { modules },
    {
      factory: async (_id, dataDir) => ({
        dir: path.join(dataDir, ".cainiao-staging"),
        status: () => ({ status: "connected", account: "test" }),
        connect: async () => ({ status: "connected" }),
        disconnect: async () => {},
        run: async () => ({ ok: true, calls: ++calls }),
      }),
    },
  );
  try {
    const browser = new CollectorBrowser(modules.sales.dataDir);
    assert.equal(browser.status().account, "test");
    assert.equal((await browser.run("account")).calls, 1);
    await assert.rejects(browser.run("eval", { code: "bad" }), /操作/);
    await assert.rejects(
      browser.run("download", { target: path.join(dir, "escape.part") }),
      /目录/,
    );
    const info = JSON.parse(
      fs.readFileSync(path.join(modules.sales.dataDir, ".web-collector.json")),
    );
    const r = await fetch(info.url, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    });
    assert.equal(r.status, 401);
    assert.equal(calls, 1);
  } finally {
    await helper.stop();
    assert.equal(
      new CollectorBrowser(modules.sales.dataDir).status().status,
      "needs-user-session",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
