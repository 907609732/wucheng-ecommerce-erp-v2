import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import { sendDingTalkAppRobotMessage } from "./dingtalk-app-robot.js";
import {
  buildInventoryMentionText,
  sendDingTalkMarkdownMessage,
  sendDingTalkTextMessage
} from "./dingtalk.js";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function dingtalkReminderConfig(env = process.env) {
  return {
    inventoryReportsEnabled: String(env.DINGTALK_INVENTORY_REPORT_ENABLED || "true").toLowerCase() !== "false",
    enabled: String(env.DINGTALK_REMINDER_ENABLED || "").toLowerCase() === "true",
    targetUserId: String(env.DINGTALK_REMINDER_TARGET_USER_ID || "").trim(),
    targetName: safeDisplayName(env.DINGTALK_REMINDER_TARGET_NAME, "陈奇慧"),
    // 这里必须是已加入目标群、启用了 Stream 消息接收的企业应用机器人，不能填仅用于 Webhook 发送的群机器人。
    botName: safeDisplayName(env.DINGTALK_REMINDER_BOT_NAME, "AI自动化机器人"),
    cancelUserIds: splitIds(env.DINGTALK_REMINDER_CANCEL_USER_IDS),
    conversationId: String(env.DINGTALK_REMINDER_CONVERSATION_ID || "").trim(),
    clientId: String(env.DINGTALK_CLIENT_ID || "").trim(),
    clientSecret: String(env.DINGTALK_CLIENT_SECRET || "").trim(),
    robotCode: String(env.DINGTALK_REMINDER_ROBOT_CODE || env.DINGTALK_CLIENT_ID || "").trim(),
    // Migrate the legacy hourly default even when it remains in an existing .env file.
    intervalMs: reminderIntervalMs(env.DINGTALK_REMINDER_INTERVAL_MS)
  };
}

export class DingTalkInventoryReminderManager {
  constructor({
    statePath,
    config = dingtalkReminderConfig(),
    sendMarkdown = sendDingTalkMarkdownMessage,
    sendText = sendDingTalkTextMessage,
    sendAppRobotMessage = sendDingTalkAppRobotMessage,
    notificationGate = () => ({ ok: true }),
    now = () => Date.now()
  }) {
    this.statePath = statePath;
    this.config = config;
    this.sendMarkdown = sendMarkdown;
    this.sendText = sendText;
    this.sendAppRobotMessage = sendAppRobotMessage;
    this.notificationGate = notificationGate;
    this.now = now;
  }

  getStatus() {
    return readState(this.statePath);
  }

  async sendInventoryReport(report) {
    if (this.config.inventoryReportsEnabled === false) {
      this.stopActive("inventory_reports_disabled");
      return { skipped: true, reason: "inventory_reports_disabled", reminder: this.getStatus() };
    }
    const gate = this.notificationGate();
    if (gate?.ok === false) {
      this.stopActive("inventory_data_validation_failed");
      return { skipped: true, reason: gate.reason || "inventory_data_validation_failed", validation: gate };
    }
    if (report?.shouldNotify === false) {
      const state = this.getStatus();
      if (state?.active) {
        writeState(this.statePath, {
          ...state,
          active: false,
          resolvedAt: new Date(this.now()).toISOString(),
          resolvedReason: "no_critical_stock_alert",
          nextReminderAt: ""
        });
      }
      return {
        skipped: true,
        reason: "no_critical_stock_alert",
        reminder: this.getStatus()
      };
    }
    if (!this.config.enabled) {
      this.stopActive("reminders_disabled");
      const conversationId = this.getConversationId();
      const result = this.canUseApplicationRobot(conversationId)
        ? await this.sendApplicationRobotMessage({
          conversationId,
          msgKey: "sampleMarkdown",
          msgParam: { title: report.title, text: report.text },
          userIds: []
        })
        : await this.sendMarkdown({ title: report.title, text: report.text });
      return {
        result,
        reminder: null
      };
    }
    if (!this.config.targetUserId) throw new Error("库存催办已启用，但未配置 DINGTALK_REMINDER_TARGET_USER_ID。");

    const now = this.now();
    const conversationId = this.getConversationId();
    const usingApplicationRobot = this.canUseApplicationRobot(conversationId);
    const reportResult = usingApplicationRobot
      ? await this.sendApplicationRobotMessage({
        conversationId,
        msgKey: "sampleMarkdown",
        msgParam: {
          title: report.title,
          text: buildApplicationRobotMentionText({
            text: report.text,
            targetUserId: this.config.targetUserId,
            targetName: this.config.targetName
          })
        },
        userIds: [this.config.targetUserId]
      })
      : await this.sendMarkdown({ title: report.title, text: report.text });
    const mentionResult = usingApplicationRobot
      ? null
      : await this.sendText({
        text: buildInventoryMentionText(this.config),
        atUserIds: [this.config.targetUserId]
      });
    const reminder = {
      version: 1,
      active: true,
      reportTitle: report.title,
      createdAt: new Date(now).toISOString(),
      acknowledgedAt: "",
      acknowledgedBy: "",
      targetUserId: this.config.targetUserId,
      targetName: this.config.targetName,
      conversationId,
      intervalMs: this.config.intervalMs,
      reminderCount: 0,
      lastSentAt: new Date(now).toISOString(),
      nextReminderAt: new Date(now + this.config.intervalMs).toISOString()
    };
    writeState(this.statePath, reminder);
    return { result: { report: reportResult, mention: mentionResult }, reminder };
  }

  async tick() {
    const state = this.getStatus();
    if (!state?.active) return { sent: false, reason: "inactive" };
    const gate = this.notificationGate();
    if (gate?.ok === false || (gate?.sourceDate && !String(state.reportTitle || "").includes(gate.sourceDate))) {
      this.stopActive(gate?.ok === false ? "inventory_data_validation_failed" : "inventory_report_date_mismatch");
      return { sent: false, reason: gate?.reason || "inventory_report_date_mismatch" };
    }
    if (Number(state.intervalMs) !== this.config.intervalMs) {
      const updated = {
        ...state,
        intervalMs: this.config.intervalMs,
        nextReminderAt: new Date(this.now() + this.config.intervalMs).toISOString()
      };
      writeState(this.statePath, updated);
      return { sent: false, reason: "interval_updated", reminder: updated };
    }
    const dueAt = Date.parse(state.nextReminderAt || "");
    if (Number.isFinite(dueAt) && dueAt > this.now()) return { sent: false, reason: "not_due" };

    const now = this.now();
    const nextCount = Number(state.reminderCount || 0) + 1;
    const conversationId = String(state.conversationId || this.getConversationId() || "").trim();
    const targetName = safeDisplayName(state.targetName, this.config.targetName);
    const payload = {
      text: `@${state.targetUserId} ${targetName}，库存报告“${state.reportTitle}”仍未确认。请在群里回复“@${this.config.botName} 收到”；管理员可回复“@${this.config.botName} 取消”。`,
      atUserIds: [state.targetUserId]
    };
    const result = this.canUseApplicationRobot(conversationId)
      ? await this.sendApplicationRobotMessage({
        conversationId,
        msgKey: "sampleText",
        msgParam: { content: payload.text },
        userIds: payload.atUserIds
      })
      : await this.sendText(payload);
    const updated = {
      ...state,
      targetName,
      intervalMs: this.config.intervalMs,
      reminderCount: nextCount,
      lastSentAt: new Date(now).toISOString(),
      nextReminderAt: new Date(now + this.config.intervalMs).toISOString()
    };
    writeState(this.statePath, updated);
    return { sent: true, result, reminder: updated };
  }

  acknowledgeRobotMessage(message) {
    const state = this.getStatus();
    if (message?.msgtype !== "text") return { acknowledged: false, reason: "not_text" };
    const senderIds = [message.senderStaffId, message.senderId].map((value) => String(value || "").trim());
    const action = reminderAction(message.text?.content);
    if (!action) return { acknowledged: false, reason: "not_reminder_action" };

    const senderId = senderIds.find(Boolean) || "";
    const isCancelUser = senderIds.some((id) => this.config.cancelUserIds?.has(id));
    if (action === "cancel" && !isCancelUser) return { acknowledged: false, reason: "cancellation_requires_admin" };
    if (!state?.active) {
      return action === "cancel"
        ? {
            acknowledged: false,
            respond: true,
            action,
            reason: "inactive",
            replyText: "当前没有进行中的库存催办。"
          }
        : { acknowledged: false, reason: "inactive" };
    }
    if (state.conversationId && String(message.conversationId || "") !== state.conversationId) {
      return { acknowledged: false, reason: "wrong_conversation" };
    }

    const isTargetUser = senderIds.includes(state.targetUserId);
    if (action === "confirm" && !isTargetUser) return { acknowledged: false, reason: "confirmation_requires_target" };

    const now = this.now();
    const updated = {
      ...state,
      active: false,
      conversationId: state.conversationId || String(message.conversationId || ""),
      acknowledgedAt: action === "confirm" ? new Date(now).toISOString() : "",
      acknowledgedBy: action === "confirm" ? senderId : "",
      cancelledAt: action === "cancel" ? new Date(now).toISOString() : "",
      cancelledBy: action === "cancel" ? senderId : "",
      nextReminderAt: ""
    };
    writeState(this.statePath, updated);
    return { acknowledged: true, action, reminder: updated };
  }

  bindGroupConversation(message) {
    if (message?.msgtype !== "text" || !bindingAction(message.text?.content)) {
      return { bound: false, reason: "not_binding_action" };
    }
    const conversationId = String(message.conversationId || "").trim();
    if (!isGroupConversation(message, conversationId)) {
      return { bound: false, reason: "not_group" };
    }
    const senderIds = [message.senderStaffId, message.senderId].map((value) => String(value || "").trim());
    if (!senderIds.some((id) => this.config.cancelUserIds?.has(id))) {
      return { bound: false, reason: "binding_requires_admin" };
    }

    const current = this.getStatus() || {};
    const alreadyBound = String(current.conversationId || this.config.conversationId || "") === conversationId;
    const updated = {
      ...current,
      version: current.version || 1,
      active: Boolean(current.active),
      conversationId,
      boundAt: current.boundAt || new Date(this.now()).toISOString(),
      boundBy: senderIds.find(Boolean) || ""
    };
    writeState(this.statePath, updated);
    return { bound: true, alreadyBound, reminder: updated };
  }

  getConversationId() {
    const state = this.getStatus();
    return String(this.config.conversationId || state?.conversationId || "").trim();
  }

  stopActive(reason = "cancelled_by_system") {
    const state = this.getStatus();
    if (!state?.active) return state;
    const updated = {
      ...state,
      active: false,
      resolvedAt: new Date(this.now()).toISOString(),
      resolvedReason: reason,
      nextReminderAt: ""
    };
    writeState(this.statePath, updated);
    return updated;
  }

  canUseApplicationRobot(conversationId) {
    return Boolean(conversationId && this.config.clientId && this.config.clientSecret && this.config.robotCode);
  }

  async sendApplicationRobotMessage({ conversationId, msgKey, msgParam, userIds }) {
    return this.sendAppRobotMessage({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      robotCode: this.config.robotCode,
      conversationId,
      msgKey,
      msgParam,
      userIds
    });
  }
}

export function startDingTalkReminderRuntime({ manager, config = manager.config, logger = console }) {
  if (!config.enabled) return { enabled: false, stop() {} };
  if (!config.clientId || !config.clientSecret) throw new Error("库存催办需要 DINGTALK_CLIENT_ID 和 DINGTALK_CLIENT_SECRET。");

  const timer = setInterval(() => {
    manager.tick().catch((error) => logger.error(`钉钉库存催办发送失败：${error.message}`));
  }, Math.min(60_000, Math.max(5_000, Math.floor(config.intervalMs / 10))));
  timer.unref?.();

  const client = new DWClient({ clientId: config.clientId, clientSecret: config.clientSecret, keepAlive: false });
  client.registerCallbackListener(TOPIC_ROBOT, async (event) => {
    try {
      const message = JSON.parse(event.data || "{}");
      const binding = manager.bindGroupConversation(message);
      const acknowledgement = manager.acknowledgeRobotMessage(message);
      if ((binding.bound || acknowledgement.acknowledged || acknowledgement.respond) && message.sessionWebhook) {
        const accessToken = await client.getAccessToken();
        const confirmation = binding.bound
          ? (binding.alreadyBound ? "日报群已处于绑定状态。" : "日报群已绑定，后续库存报告和催办将从本机器人发送。")
          : acknowledgement.replyText || (acknowledgement.action === "cancel"
          ? "已取消本次库存催办。"
          : `收到，${manager.config.targetName}。本次库存催办已停止。`);
        const response = await axios.post(message.sessionWebhook, {
          msgtype: "text",
          text: { content: `@${message.senderStaffId || ""} ${confirmation}` },
          at: { atUserIds: [message.senderStaffId].filter(Boolean), isAtAll: false }
        }, { headers: { "x-acs-dingtalk-access-token": accessToken } });
        client.socketCallBackResponse(event.headers.messageId, response.data);
        return;
      }
      client.socketCallBackResponse(event.headers.messageId, { status: "SUCCESS" });
    } catch (error) {
      logger.error(`处理钉钉群消息失败：${error.message}`);
      client.socketCallBackResponse(event.headers.messageId, { status: "SUCCESS" });
    }
  });
  client.connect().then(() => logger.log("钉钉库存催办 Stream 已连接。"))
    .catch((error) => logger.error(`钉钉库存催办 Stream 连接失败：${error.message}`));

  return {
    enabled: true,
    client,
    stop() {
      clearInterval(timer);
      client.disconnect();
    }
  };
}

export function isAcknowledgement(content) {
  return reminderAction(content) === "confirm";
}

export function reminderAction(content) {
  const raw = String(content || "").trim();
  const normalized = raw.replace(/^@[\s\S]+?\s+(?=(收到|取消)[！!。.\s]*$)/u, "");
  if (/^收到[！!。.\s]*$/u.test(normalized)) return "confirm";
  if (/^取消[！!。.\s]*$/u.test(normalized)) return "cancel";
  return null;
}

function bindingAction(content) {
  const raw = String(content || "").trim();
  const normalized = raw.replace(/^@[\s\S]+?\s+(?=绑定日报群[！!。.\s]*$)/u, "");
  return /^绑定日报群[！!。.\s]*$/u.test(normalized);
}

function isGroupConversation(message, conversationId) {
  return String(message?.conversationType || "") === "2" || conversationId.startsWith("cid");
}

export function buildApplicationRobotMentionText({ text, targetUserId, targetName = "" }) {
  const userId = String(targetUserId || "").trim();
  const name = String(targetName || "").trim();
  const body = String(text || "").trim();
  if (!userId) return body;

  const mention = `@${userId}${name ? ` ${name}` : ""}`;
  return body.startsWith(`@${userId}`)
    ? body
    : `${mention}\n\n${body}`;
}


function splitIds(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, statePath);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function reminderIntervalMs(value) {
  const intervalMs = positiveInteger(value, DEFAULT_INTERVAL_MS);
  return intervalMs === 60 * 60 * 1000 ? DEFAULT_INTERVAL_MS : intervalMs;
}

function safeDisplayName(value, fallback) {
  const normalized = String(value || "").trim();
  const looksLikeUtf8DecodedAsGbk = /(?:鑷姩|鍖栨満|鍣ㄤ汉|闄堝鎱)/u.test(normalized);
  if (
    !normalized
    || /(?:^|\s)DINGTALK_[A-Z0-9_]+=/u.test(normalized)
    || normalized.includes("�")
    || looksLikeUtf8DecodedAsGbk
  ) {
    return fallback;
  }
  return normalized;
}
