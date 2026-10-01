import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteService } from "../desktop/shared/remote-service.mjs";

function service(overrides = {}) {
  return createRemoteService({
    requireAccessIdentity: true,
    operatorEmails: ["operator@example.com"],
    getHealth: async () => ({ version: "test" }),
    getInventory: async () => ({ available: true, skuCount: 2 }),
    getMonthlySales: async (filters) => ({ available: true, filters }),
    getTaskState: async () => ({ running: false }),
    startTask: async (kind, trigger, options, actor) => ({ kind, trigger, options, actor }),
    stopTask: async (actor) => actor,
    ...overrides
  });
}

test("remote service health is available without exposing data", async () => {
  const remote = service();
  const health = await remote.app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().version, "test");
  const inventory = await remote.app.inject({ method: "GET", url: "/api/v1/inventory" });
  assert.equal(inventory.statusCode, 401);
  await remote.stop();
});

test("authenticated viewers can read but only listed operators can run tasks", async () => {
  const remote = service();
  const viewerHeaders = { "cf-access-authenticated-user-email": "viewer@example.com" };
  const inventory = await remote.app.inject({ method: "GET", url: "/api/v1/inventory", headers: viewerHeaders });
  assert.equal(inventory.statusCode, 200);
  assert.equal(inventory.json().data.skuCount, 2);
  const denied = await remote.app.inject({ method: "POST", url: "/api/v1/jobs", headers: viewerHeaders, payload: { type: "sync" } });
  assert.equal(denied.statusCode, 403);

  const allowed = await remote.app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { "cf-access-authenticated-user-email": "operator@example.com" },
    payload: { type: "monthly-sales", month: "2026-09" }
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().data.kind, "monthly-sales");
  assert.equal(allowed.json().data.actor.requestedBy, "operator@example.com");
  await remote.stop();
});

test("remote service never accepts arbitrary commands", async () => {
  const remote = service();
  const response = await remote.app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { "cf-access-authenticated-user-email": "operator@example.com" },
    payload: { type: "shell", command: "whoami" }
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /不支持/);
  await remote.stop();
});

test("remote service refuses non-loopback listeners", () => {
  assert.throws(() => createRemoteService({ host: "0.0.0.0" }), /回环地址/);
});
