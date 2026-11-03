import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { verifyServices } from "../server/readiness.mjs";
test("release readiness starts all modules and fails when a real read API is unhealthy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-ready-"));
  for (const name of [".workbench-key", ".integration-key"])
    fs.writeFileSync(path.join(dir, name), "a".repeat(64));
  const started = [];
  const backend = http.createServer((q, r) => {
    r.setHeader("content-type", "application/json");
    r.statusCode = q.url.startsWith("/api/dashboard") ? 503 : 200;
    r.end("{}");
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const services = {
    config: () => ({ dataDir: dir }),
    ensure: async (id) => {
      started.push(id);
      return {
        url: "http://127.0.0.1:" + backend.address().port,
        dataSetId: "a0000000-0000-4000-8000-000000000001",
      };
    },
  };
  try {
    await assert.rejects(verifyServices(services), /只读检查/);
    assert(started.includes("purchase"));
  } finally {
    await new Promise((r) => backend.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
