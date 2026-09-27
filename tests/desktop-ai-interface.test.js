import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AI_TOOLS, parseCliRequest } from "../desktop/shared/ai-interface.mjs";
import { diagnosticHealth, diagnosticLogLevel, sanitizeDiagnosticText, searchDiagnosticLines } from "../desktop/shared/diagnostics.mjs";
import { discoverExtensions } from "../desktop/shared/extensions.mjs";
import { createRuntimeCapabilities } from "../desktop/shared/runtime-contract.mjs";

test("AI interface exposes the intended MCP tool set", () => {
  assert.deepEqual(AI_TOOLS, [
    "inventory_status",
    "inventory_recent_logs",
    "inventory_debug_diagnose",
    "inventory_debug_search_logs",
    "inventory_runtime_capabilities",
    "inventory_debug_export_bundle",
    "inventory_extension_list",
    "inventory_extension_call",
    "inventory_sync_once",
    "cainiao_refresh_login"
  ]);
});

test("CLI read-only commands need no confirmation", () => {
  assert.deepEqual(parseCliRequest(["status"]), { command: "status" });
  assert.deepEqual(parseCliRequest(["capabilities"]), { command: "capabilities" });
  assert.deepEqual(parseCliRequest(["doctor"]), { command: "doctor" });
  assert.deepEqual(parseCliRequest(["debug-bundle"]), { command: "debug-bundle" });
  assert.deepEqual(parseCliRequest(["extensions"]), { command: "extensions" });
  assert.deepEqual(parseCliRequest(["logs", "--limit=500"]), { command: "logs", limit: 100 });
  assert.deepEqual(parseCliRequest(["debug-logs", "--level=error", "--query=登录", "--limit=500"]), {
    command: "debug-logs", limit: 100, level: "error", query: "登录"
  });
});

test("extension CLI keeps trust and side effects behind explicit confirmation", () => {
  assert.throws(() => parseCliRequest(["extension-trust", "--id=sample.extension"]), /--confirm-trust-code/);
  assert.deepEqual(parseCliRequest(["extension-trust", "--id=sample.extension", "--confirm-trust-code"]), {
    command: "extension-trust", id: "sample.extension", confirmed: true
  });
  const encoded = Buffer.from(JSON.stringify({ value: 3 })).toString("base64url");
  assert.deepEqual(parseCliRequest(["extension-call", "--id=sample.extension", "--action=diagnose", `--params-base64=${encoded}`]), {
    command: "extension-call", id: "sample.extension", action: "diagnose", params: { value: 3 }, confirmSideEffect: false
  });
});

test("runtime capabilities advertise source, portable, installed and extension modes", () => {
  const capabilities = createRuntimeCapabilities({ version: "0.4.1", packaged: false, executable: "electron.exe", workspace: "C:\\workspace", sourceRoot: "C:\\repo" });
  assert.equal(capabilities.schemaVersion, "1.0.0");
  assert.deepEqual(capabilities.modes.map((mode) => mode.id), ["source", "cli", "mcp-stdio", "portable", "installed"]);
  assert.equal(capabilities.extensions.trustRequired, true);
  assert.equal(capabilities.application.source.editable, true);
});

test("daily inventory scripts use the local direct-send flow", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["sync:inventory:local"], "node core/sync-cainiao-inventory.js");
  assert.equal(packageJson.scripts["sync:inventory:full"], undefined);
  assert.equal(packageJson.scripts["sync:inventory:cloud"], undefined);
});

test("extension discovery is declarative and does not load code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cainiao-extension-test-"));
  try {
    const directory = path.join(root, "sample-extension");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "extension.json"), JSON.stringify({
      id: "sample.extension", name: "Sample", version: "1.0.0", apiVersion: "1", entry: "extension.mjs",
      actions: [{ name: "diagnose", description: "read", sideEffect: "read" }]
    }));
    fs.writeFileSync(path.join(directory, "extension.mjs"), "throw new Error('must not load during discovery');\n");
    const [extension] = discoverExtensions(root, ["sample.extension"]);
    assert.equal(extension.valid, true);
    assert.equal(extension.trusted, true);
    assert.equal(extension.actions[0].name, "diagnose");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AI diagnostics redact secrets and filter plain-text logs", () => {
  const lines = ["同步成功", "登录失败 password=secret-value", "warning: token=abc123"];
  assert.equal(sanitizeDiagnosticText(lines[1], ["secret-value"]), "登录失败 password=[REDACTED]");
  assert.equal(diagnosticLogLevel(lines[1]), "error");
  assert.deepEqual(searchDiagnosticLines(lines, { level: "error", sensitiveValues: ["secret-value"] }), ["登录失败 password=[REDACTED]"]);
});

test("AI diagnostics aggregate health without hiding warnings", () => {
  assert.deepEqual(diagnosticHealth([{ status: "ok" }, { status: "warning" }]), {
    status: "warning", errorCount: 0, warningCount: 1
  });
});

test("CLI sync requires an explicit send confirmation", () => {
  assert.throws(() => parseCliRequest(["sync"]), /--confirm-send/);
  assert.deepEqual(parseCliRequest(["sync", "--confirm-send"]), { command: "sync", confirmed: true });
});

test("CLI login requires an explicit browser confirmation", () => {
  assert.throws(() => parseCliRequest(["login"]), /--confirm-open-browser/);
  assert.deepEqual(parseCliRequest(["login", "--confirm-open-browser"]), { command: "login", confirmed: true });
});
