import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  developmentConfig,
  loadConfig,
  validateConfig,
} from "../server/config.mjs";
import { ServiceManager } from "../server/service-manager.mjs";
const root = path.resolve(import.meta.dirname, "..");
test("development uses an explicit isolated directory and only three source modules", () => {
  const c = developmentConfig({
    root,
    stateDir: path.join(os.tmpdir(), "erp-web-config-test"),
  });
  assert.equal(c.mode, "development");
  assert.equal(c.host, "127.0.0.1");
  assert.deepEqual(Object.keys(c.modules), ["purchase", "sales", "overview"]);
  for (const [id, m] of Object.entries(c.modules)) {
    assert.equal(m.root, path.join(root, "apps", id));
    assert(m.dataDir.startsWith(c.stateDir + path.sep));
  }
  assert.throws(() => developmentConfig({ root, stateDir: root }), /隔离/);
});
test("production never guesses ledger paths or initializes missing books", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-web-config-"));
  try {
    assert.throws(() => loadConfig(path.join(dir, "absent.json")), /配置/);
    const c = {
      ...developmentConfig({ root, stateDir: dir }),
      mode: "production",
      publicOrigin: "https://erp.example.ts.net",
    };
    assert.throws(() => validateConfig(c), /账本/);
    assert.throws(
      () => validateConfig({ ...c, publicOrigin: "http://0.0.0.0:3000" }),
      /HTTPS/,
    );
    assert.throws(
      () => validateConfig({ ...c, modules: { ...c.modules, warehouse: {} } }),
      /三个/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("an explicit managed sales port is not replaced by copied legacy server.port", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-port-"));
  try {
    fs.writeFileSync(path.join(dir, "server.port"), "17870");
    const registryFile = path.join(dir, "registry.json");
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ sales: { managed: true, root: dir, dataDir: dir, port: 41062 } }),
    );
    assert.equal(
      new ServiceManager({ registryFile }).config("sales").port,
      41062,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
