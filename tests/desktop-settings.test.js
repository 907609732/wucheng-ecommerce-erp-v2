import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  nextRunAt,
  nextMonthlyRunAt,
  normalizeSettings,
  validateAutomationSettings,
  validateCainiaoSettings,
  validateDingTalkSettings,
  validateRuntimeSettings,
  validateSettings
} from "../desktop/shared/settings.mjs";
import { decryptedText } from "../desktop/shared/secret-storage.mjs";
import { canonicalUserDataPath, requestedUserDataPath } from "../desktop/shared/user-data-path.mjs";
import brandingModule from "../desktop/shared/branding.cjs";

const { buildBranding } = brandingModule;

test("only formal release builds use the unmarked product name", () => {
  assert.deepEqual(buildBranding("release"), {
    channel: "release", official: true, productName: "云仓库存同步", artifactMarker: ""
  });
  for (const channel of ["test", "beta", "development", "unknown"]) {
    const branding = buildBranding(channel);
    assert.equal(branding.official, false);
    assert.equal(branding.productName, "云仓库存同步（测试版）");
    assert.equal(branding.artifactMarker, "-Test");
  }
});

test("desktop, CLI and portable builds share one stable Windows user data directory", () => {
  assert.equal(
    canonicalUserDataPath("C:\\Users\\demo\\AppData\\Roaming"),
    "C:\\Users\\demo\\AppData\\Roaming\\wucheng-ecommerce-erp-v2"
  );
});

test("an explicit user data directory remains available to isolated UI and MCP runs", () => {
  assert.equal(
    requestedUserDataPath(["assistant.exe", "--user-data-dir=C:\\Temp\\assistant-test"]),
    "C:\\Temp\\assistant-test"
  );
});

test("desktop automation is opt-in before the first valid save", () => {
  assert.equal(DEFAULT_SETTINGS.runtimeMode, "standalone");
  assert.equal(DEFAULT_SETTINGS.remoteServerUrl, "https://erp.4444520.xyz");
  assert.equal(DEFAULT_SETTINGS.scheduleEnabled, false);
  assert.equal(DEFAULT_SETTINGS.startAtLogin, false);
});

test("trusted extension ids are normalized and deduplicated", () => {
  const settings = normalizeSettings({ trustedExtensionIds: ["Sample.Extension", "sample.extension", ""] });
  assert.deepEqual(settings.trustedExtensionIds, ["sample.extension"]);
});

test("GitHub update token is treated as an encrypted secret", async () => {
  const { EDITABLE_SECRET_FIELDS, SECRET_FIELDS } = await import("../desktop/shared/settings.mjs");
  assert.equal(SECRET_FIELDS.includes("githubUpdateToken"), true);
  assert.equal(EDITABLE_SECRET_FIELDS.includes("githubUpdateToken"), false);
  assert.deepEqual(EDITABLE_SECRET_FIELDS, [
    "cainiaoPassword",
    "dingtalkClientId",
    "dingtalkClientSecret",
    "dingtalkWebhook",
    "dingtalkWebhookSecret"
  ]);
});

test("Electron async safeStorage decrypt result is unwrapped", () => {
  assert.equal(decryptedText({ shouldReEncrypt: false, result: '{"saved":true}' }), '{"saved":true}');
  assert.equal(decryptedText('{"legacy":true}'), '{"legacy":true}');
});

test("Cainiao login can be refreshed before DingTalk is configured", () => {
  const result = validateCainiaoSettings({ cainiaoUsername: "user" }, { cainiaoPassword: true });
  assert.equal(result.ok, true);
});

test("Cainiao account and DingTalk robot can be validated independently", () => {
  const account = validateCainiaoSettings({ cainiaoUsername: "user" }, { cainiaoPassword: true });
  const robot = validateDingTalkSettings({
    deliveryMode: "app",
    dingtalkRobotCode: "robot",
    dingtalkConversationId: "cid-example"
  }, { dingtalkClientId: true, dingtalkClientSecret: true });
  assert.equal(account.ok, true);
  assert.equal(robot.ok, true);
});

test("automation settings can be saved before account and robot configuration", () => {
  const result = validateAutomationSettings({ scheduleTime: "08:30", lowStockThreshold: 12 });
  assert.equal(result.ok, true);
});

test("desktop settings validate an enterprise robot configuration", () => {
  const settings = normalizeSettings({
    cainiaoUsername: "user",
    scheduleTime: "22:00",
    lowStockThreshold: 10,
    deliveryMode: "app",
    dingtalkRobotCode: "robot",
    dingtalkConversationId: "cid-example"
  });
  const result = validateSettings(settings, {
    cainiaoPassword: true,
    dingtalkClientId: true,
    dingtalkClientSecret: true
  });
  assert.equal(result.ok, true);
});

test("desktop settings reject an incomplete webhook configuration", () => {
  const result = validateSettings({
    cainiaoUsername: "user",
    scheduleTime: "22:00",
    lowStockThreshold: 10,
    deliveryMode: "webhook"
  }, { cainiaoPassword: true, dingtalkWebhook: false });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /Webhook/);
});

test("nextRunAt schedules tomorrow after today's time passed", () => {
  const now = new Date(2026, 8, 26, 22, 30, 0);
  const result = nextRunAt("22:00", now);
  assert.equal(result.getDate(), 27);
  assert.equal(result.getHours(), 22);
  assert.equal(result.getMinutes(), 0);
});

test("runtime modes keep the remote origin HTTPS-only and the API loopback port valid", () => {
  assert.equal(validateRuntimeSettings({ runtimeMode: "client", remoteServerUrl: "https://erp.4444520.xyz", remoteServerPort: 17320 }).ok, true);
  assert.equal(validateRuntimeSettings({ runtimeMode: "client", remoteServerUrl: "http://erp.4444520.xyz", remoteServerPort: 17320 }).ok, false);
  assert.equal(validateRuntimeSettings({ runtimeMode: "server", remoteServerPort: 80 }).ok, false);
});

test("nextMonthlyRunAt uses this month's first day before the cutoff and next month after it", () => {
  const beforeCutoff = nextMonthlyRunAt("22:00", new Date(2026, 8, 1, 10, 0, 0));
  assert.deepEqual(
    [beforeCutoff.getFullYear(), beforeCutoff.getMonth(), beforeCutoff.getDate(), beforeCutoff.getHours(), beforeCutoff.getMinutes()],
    [2026, 8, 1, 22, 0]
  );

  const afterCutoff = nextMonthlyRunAt("22:00", new Date(2026, 8, 2, 10, 0, 0));
  assert.deepEqual(
    [afterCutoff.getFullYear(), afterCutoff.getMonth(), afterCutoff.getDate(), afterCutoff.getHours(), afterCutoff.getMinutes()],
    [2026, 9, 1, 22, 0]
  );
});
