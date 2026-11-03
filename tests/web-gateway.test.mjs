import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkbenchGateway } from "../server/gateway/gateway.mjs";
const ids = ["purchase", "sales", "overview"];
test("explicit development mode has local sessions, CSRF, and only three modules", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-gateway-"));
  const services = { config: () => ({}), capabilities: async () => null };
  const g = await createWorkbenchGateway({
    services,
    storeDir: dir,
    publicOrigin: "http://127.0.0.1:28430",
    localDevelopment: true,
    moduleIds: ids,
    port: 0,
  });
  t.after(async () => {
    await g.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const r = await g.app.inject({
    url: "/api/workbench/v1/session",
    headers: { host: "127.0.0.1:28430" },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().actor.modules, ids);
  assert.equal(r.json().actor.login, "local-development");
  const cookie = r.headers["set-cookie"].split(";")[0];
  assert(cookie.startsWith("workbench-dev-session="));
  const headers = { host: "127.0.0.1:28430", cookie };
  assert.equal(
    (await g.app.inject({ url: "/apps/warehouse/", headers })).statusCode,
    404,
  );
  assert.equal(
    (
      await g.app.inject({
        url: "/api/workbench/v1/session",
        headers: { host: "evil.test" },
      })
    ).statusCode,
    421,
  );
  assert.equal(
    (
      await g.app.inject({
        url: "/api/workbench/v1/session",
        headers: { host: "127.0.0.1:28430", origin: "https://evil.test" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await g.app.inject({
        url: "/api/workbench/v1/session",
        headers: {
          host: "127.0.0.1:28430",
          "tailscale-user-login": "forged@test",
        },
      })
    ).statusCode,
    400,
  );
});
test("production cannot enable local identity on a remote or HTTPS origin", async () => {
  await assert.rejects(
    createWorkbenchGateway({
      services: {},
      storeDir: "unused",
      publicOrigin: "https://erp.ts.net",
      localDevelopment: true,
    }),
    /开发/,
  );
  await assert.rejects(
    createWorkbenchGateway({
      services: {},
      storeDir: "unused",
      publicOrigin: "http://127.0.0.1:28430",
    }),
    /HTTPS/,
  );
});
