import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DingTalkInventoryReminderManager,
  dingtalkReminderConfig,
  isAcknowledgement,
  reminderAction
} from "../core/dingtalk-inventory-reminder.js";
import { buildDingTalkMarkdownPayload, buildDingTalkTextPayload } from "../core/dingtalk.js";
import {
  buildInventoryMarkdown,
  buildInventoryPeriodSummary,
  formatInventoryAlertLabel
} from "../core/erp/reports.js";

test("builds a DingTalk markdown payload that mentions one user", () => {
  assert.deepEqual(buildDingTalkMarkdownPayload({
    title: "库存日报",
    text: "请确认",
    atUserIds: ["user-chen", "user-chen", ""]
  }), {
    msgtype: "markdown",
    markdown: { title: "库存日报", text: "请确认" },
    at: { atUserIds: ["user-chen"], atMobiles: [], isAtAll: false }
  });
});

test("builds a text payload that creates a native DingTalk mention", () => {
  assert.deepEqual(buildDingTalkTextPayload({
    text: "@user-chen 陈奇慧，请确认",
    atUserIds: ["user-chen"]
  }), {
    msgtype: "text",
    text: { content: "@user-chen 陈奇慧，请确认" },
    at: { atUserIds: ["user-chen"], atMobiles: [], isAtAll: false }
  });
});

test("migrates the legacy hourly setting to daily reminders and ignores malformed display names", () => {
  const config = dingtalkReminderConfig({
    DINGTALK_REMINDER_INTERVAL_MS: "3600000",
    DINGTALK_REMINDER_TARGET_NAME: "陈奇慧 DINGTALK_REMINDER_TARGET_USER_ID=unexpected",
    DINGTALK_REMINDER_BOT_NAME: "AI自动化机器人"
  });
  assert.equal(config.intervalMs, 24 * 60 * 60 * 1000);
  assert.equal(config.targetName, "陈奇慧");
  assert.equal(config.botName, "AI自动化机器人");
});

test("falls back from legacy UTF-8-as-GBK display-name mojibake", () => {
  const config = dingtalkReminderConfig({
    DINGTALK_REMINDER_TARGET_NAME: "闄堝鎱",
    DINGTALK_REMINDER_BOT_NAME: "AI鑷姩鍖栨満鍣ㄤ汉"
  });
  assert.equal(config.targetName, "陈奇慧");
  assert.equal(config.botName, "AI自动化机器人");
});

test("disables every inventory DingTalk report and closes an active reminder", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reports-disabled-test-"));
  const statePath = path.join(tempDir, "reminder.json");
  fs.writeFileSync(statePath, JSON.stringify({ active: true, reportTitle: "库存日报" }));
  const sent = [];
  const manager = new DingTalkInventoryReminderManager({
    statePath,
    config: { inventoryReportsEnabled: false, enabled: true },
    sendMarkdown: async (payload) => sent.push(payload)
  });

  const result = await manager.sendInventoryReport({ title: "库存日报", text: "库存正文" });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "inventory_reports_disabled");
  assert.equal(sent.length, 0);
  assert.equal(manager.getStatus().active, false);
  assert.equal(manager.getStatus().resolvedReason, "inventory_reports_disabled");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("sends one inventory report while follow-up reminders are disabled", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reminders-disabled-test-"));
  const statePath = path.join(tempDir, "reminder.json");
  fs.writeFileSync(statePath, JSON.stringify({ active: true, conversationId: "conversation-1" }));
  const sent = [];
  const manager = new DingTalkInventoryReminderManager({
    statePath,
    config: {
      inventoryReportsEnabled: true,
      enabled: false,
      conversationId: "conversation-1",
      clientId: "client-id",
      clientSecret: "client-secret",
      robotCode: "robot-code"
    },
    sendMarkdown: async () => {
      throw new Error("must not fall back to the legacy webhook");
    },
    sendAppRobotMessage: async (payload) => {
      sent.push(payload);
      return { ok: true };
    }
  });

  const result = await manager.sendInventoryReport({ title: "库存日报", text: "库存正文" });
  assert.deepEqual(result.result, { ok: true });
  assert.equal(result.reminder, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, "conversation-1");
  assert.deepEqual(sent[0].userIds, []);
  assert.equal(manager.getStatus().active, false);
  assert.equal(manager.getStatus().resolvedReason, "reminders_disabled");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("builds inventory Markdown with real line breaks", () => {
  const report = buildInventoryMarkdown("table", {
    snapshotDate: "2026-09-25",
    skuCount: 1,
    totalQuantity: 6,
    lowStockItems: [{
      name: "螺丝-小米钥匙白色螺丝(baise)",
      sku: "BSYSLS01",
      totalQuantity: 6,
      near30DaysSales: 30,
      sellableDays: 6,
      stockAlert: { level: "critical" }
    }]
  });
  assert.match(report.text, /\n/);
  assert.equal(report.text.includes("\\n"), false);
  assert.match(report.text, /\| \u8D27\u54C1\u540D\u79F0 \| SKU \| \u5E93\u5B58\/\u9500\u91CF \| \u53EF\u552E\u5929\u6570 \| \u9884\u8B66 \|/);
  assert.match(report.text, /\| \u87BA\u4E1D-\u5C0F\u7C73\u94A5\u5319\u767D\u8272\u87BA\u4E1D\(baise\) \| BSYSLS01 \|/);
});

test("uses Chinese warning labels in DingTalk inventory Markdown", () => {
  assert.equal(formatInventoryAlertLabel("critical"), "🔴 不够卖 1 周");
  assert.equal(formatInventoryAlertLabel("urgent"), "🟠 不够卖 2 周");
  assert.equal(formatInventoryAlertLabel("warning"), "🟡 不够卖 1 月");
  assert.equal(formatInventoryAlertLabel("ok"), "🟢 正常");
  assert.equal(formatInventoryAlertLabel("unknown"), "🟢 正常");

  const report = buildInventoryMarkdown("table");
  assert.doesNotMatch(report.text, /CRITICAL|URGENT|LOW <30d|NORMAL/);
});

test("summarizes every replenishment period while keeping one-week alerts distinct", () => {
  const summary = buildInventoryPeriodSummary([
    { sellableDays: 0 },
    { sellableDays: 6.9 },
    { sellableDays: 7 },
    { sellableDays: 13.9 },
    { sellableDays: 14.2 },
    { sellableDays: 15 },
    { sellableDays: 29.9 },
    { sellableDays: Infinity }
  ]);
  assert.deepEqual(summary, { week: 2, twoWeeks: 4, halfMonth: 5, month: 7 });
});

test("reminds daily and only accepts the target user's acknowledgement", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reminder-test-"));
  const statePath = path.join(tempDir, "reminder.json");
  const sent = [];
  let now = Date.parse("2026-07-14T01:00:00.000Z");
  const manager = new DingTalkInventoryReminderManager({
    statePath,
    config: {
      enabled: true,
      targetUserId: "user-chen",
      targetName: "陈奇慧",
      botName: "AI自动化机器人",
      cancelUserIds: new Set(["user-owner"]),
      conversationId: "conversation-1",
      intervalMs: 24 * 60 * 60 * 1000
    },
    sendMarkdown: async (payload) => {
      sent.push({ type: "markdown", payload });
      return { errcode: 0 };
    },
    sendText: async (payload) => {
      sent.push({ type: "text", payload });
      return { errcode: 0 };
    },
    now: () => now
  });

  await manager.sendInventoryReport({ title: "库存日报", text: "库存正文" });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "markdown");
  assert.equal(sent[1].type, "text");
  assert.deepEqual(sent[1].payload.atUserIds, ["user-chen"]);
  assert.match(sent[1].payload.text, /^@user-chen/);

  now += 23 * 60 * 60 * 1000;
  assert.equal((await manager.tick()).sent, false);
  now += 60 * 60 * 1000;
  assert.equal((await manager.tick()).sent, true);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].type, "text");

  assert.equal(manager.acknowledgeRobotMessage({
    msgtype: "text",
    senderStaffId: "someone-else",
    conversationId: "conversation-1",
    text: { content: "收到" }
  }).acknowledged, false);
  assert.equal(manager.acknowledgeRobotMessage({
    msgtype: "text",
    senderStaffId: "user-chen",
    conversationId: "conversation-1",
    text: { content: "收到！" }
  }).acknowledged, true);

  now += 24 * 60 * 60 * 1000;
  assert.equal((await manager.tick()).sent, false);
  assert.equal(manager.getStatus().active, false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("allows only configured administrators to cancel an active reminder", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reminder-cancel-test-"));
  const statePath = path.join(tempDir, "reminder.json");
  const config = {
    enabled: true,
    targetUserId: "user-chen",
    targetName: "陈奇慧",
    botName: "AI自动化机器人",
    cancelUserIds: new Set(["user-owner"]),
    conversationId: "conversation-1",
    intervalMs: 60 * 60 * 1000
  };
  const manager = new DingTalkInventoryReminderManager({
    statePath,
    config,
    sendMarkdown: async () => ({ errcode: 0 }),
    sendText: async () => ({ errcode: 0 })
  });
  await manager.sendInventoryReport({ title: "库存日报", text: "库存正文" });
  assert.equal(manager.acknowledgeRobotMessage({
    msgtype: "text", senderStaffId: "someone-else", conversationId: "conversation-1", text: { content: "@AI自动化机器人 取消" }
  }).acknowledged, false);
  const cancelled = manager.acknowledgeRobotMessage({
    msgtype: "text", senderStaffId: "user-owner", conversationId: "conversation-1", text: { content: "@AI自动化机器人 取消" }
  });
  assert.equal(cancelled.acknowledged, true);
  assert.equal(cancelled.action, "cancel");
  assert.equal(manager.getStatus().active, false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("binds an administrator-selected group and uses the enterprise robot sender", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reminder-binding-test-"));
  const sent = [];
  const manager = new DingTalkInventoryReminderManager({
    statePath: path.join(tempDir, "reminder.json"),
    config: {
      enabled: true,
      targetUserId: "user-chen",
      targetName: "陈奇慧",
      botName: "AI自动化机器人",
      cancelUserIds: new Set(["user-owner"]),
      conversationId: "",
      clientId: "ding-app-key",
      clientSecret: "app-secret",
      robotCode: "ding-app-key",
      intervalMs: 60 * 60 * 1000
    },
    sendAppRobotMessage: async (payload) => {
      sent.push(payload);
      return { processQueryKey: "ok" };
    }
  });

  assert.equal(manager.bindGroupConversation({
    msgtype: "text",
    conversationType: "2",
    conversationId: "cid-report-group",
    senderStaffId: "someone-else",
    text: { content: "@AI自动化机器人 绑定日报群" }
  }).bound, false);

  const binding = manager.bindGroupConversation({
    msgtype: "text",
    conversationType: "2",
    conversationId: "cid-report-group",
    senderStaffId: "user-owner",
    text: { content: "@AI自动化机器人 绑定日报群" }
  });
  assert.equal(binding.bound, true);
  assert.equal(manager.getConversationId(), "cid-report-group");

  await manager.sendInventoryReport({ title: "库存日报", text: "库存正文" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, "cid-report-group");
  assert.equal(sent[0].msgKey, "sampleMarkdown");
  assert.deepEqual(sent[0].userIds, ["user-chen"]);
  assert.equal(sent[0].msgParam.text, "@user-chen 陈奇慧\n\n库存正文");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("an administrator receives feedback when there is no active reminder to cancel", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reminder-inactive-cancel-test-"));
  const manager = new DingTalkInventoryReminderManager({
    statePath: path.join(tempDir, "reminder.json"),
    config: {
      enabled: true,
      targetUserId: "user-chen",
      targetName: "陈奇慧",
      botName: "AI自动化机器人",
      cancelUserIds: new Set(["user-owner"]),
      conversationId: "",
      intervalMs: 60 * 60 * 1000
    }
  });

  const result = manager.acknowledgeRobotMessage({
    msgtype: "text",
    senderStaffId: "user-owner",
    text: { content: "@AI 自动化机器人 取消" }
  });
  assert.equal(result.acknowledged, false);
  assert.equal(result.respond, true);
  assert.equal(result.replyText, "当前没有进行中的库存催办。");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("skips DingTalk and closes an active reminder when no SKU is under one week", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reminder-critical-test-"));
  const statePath = path.join(tempDir, "reminder.json");
  let now = Date.parse("2026-07-16T01:00:00.000Z");
  const manager = new DingTalkInventoryReminderManager({
    statePath,
    config: {
      enabled: true,
      targetUserId: "user-chen",
      targetName: "陈奇慧",
      botName: "AI自动化机器人",
      cancelUserIds: new Set(),
      conversationId: "conversation-1",
      intervalMs: 60 * 60 * 1000
    },
    sendMarkdown: async () => { throw new Error("不应发送 Markdown"); },
    sendText: async () => { throw new Error("不应发送 @ 提醒"); },
    now: () => now
  });
  fs.writeFileSync(statePath, JSON.stringify({ active: true, nextReminderAt: new Date(now).toISOString() }));

  const result = await manager.sendInventoryReport({
    title: "库存日报",
    text: "暂无严重缺货",
    shouldNotify: false
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no_critical_stock_alert");
  assert.equal(manager.getStatus().active, false);
  assert.equal(manager.getStatus().resolvedReason, "no_critical_stock_alert");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("acknowledgement text must be an explicit received reply", () => {
  assert.equal(isAcknowledgement("收到"), true);
  assert.equal(isAcknowledgement("@快递拆包取证 收到。"), true);
  assert.equal(isAcknowledgement("我还没收到"), false);
  assert.equal(reminderAction("@AI自动化机器人 取消"), "cancel");
  assert.equal(reminderAction("@AI 自动化机器人 取消"), "cancel");
});

test("a failed inventory validation closes an active reminder without sending", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-reminder-validation-test-"));
  const statePath = path.join(tempDir, "reminder.json");
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    reportTitle: "ERP库存预警 2026-07-17",
    targetUserId: "target-user",
    nextReminderAt: "2000-01-01T00:00:00.000Z"
  }));
  let sendCount = 0;
  const manager = new DingTalkInventoryReminderManager({
    statePath,
    config: {
      enabled: true,
      targetUserId: "target-user",
      targetName: "陈奇慧",
      botName: "AI自动化机器人",
      cancelUserIds: new Set(["admin-user"]),
      conversationId: "conversation-1",
      clientId: "client-id",
      clientSecret: "client-secret",
      robotCode: "robot-code",
      intervalMs: 60 * 60 * 1000
    },
    notificationGate: () => ({ ok: false, reason: "invalid" }),
    sendAppRobotMessage: async () => { sendCount += 1; }
  });

  const result = await manager.tick();
  assert.equal(result.sent, false);
  assert.equal(sendCount, 0);
  assert.equal(manager.getStatus().active, false);
  assert.equal(manager.getStatus().resolvedReason, "inventory_data_validation_failed");
});
