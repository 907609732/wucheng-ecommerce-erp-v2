import crypto from "node:crypto";
import axios from "axios";
import { sendDingTalkAppRobotMessage } from "./dingtalk-app-robot.js";

function buildWebhookUrl(webhook, secret) {
  if (!secret) return webhook;

  const timestamp = Date.now();
  const signSource = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac("sha256", secret)
    .update(signSource)
    .digest("base64");

  const url = new URL(webhook);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

export async function sendDingTalkMarkdown({ title, text }) {
  return sendDingTalkMarkdownMessage({ title, text });
}

export async function sendInventoryDingTalkMarkdown({ title, text, shouldNotify = true }) {
  if (!shouldNotify) {
    console.log("暂无预计一周内售罄的商品，跳过钉钉库存提醒。");
    return { skipped: true, reason: "no_critical_stock_alert" };
  }
  if (process.env.DINGTALK_SKIP_SEND === "1") {
    console.log("已设置 DINGTALK_SKIP_SEND=1，库存消息交由云端催办服务发送。");
    return { skipped: true };
  }

  if (String(process.env.DINGTALK_DELIVERY_MODE || "").toLowerCase() === "app") {
    const clientId = String(process.env.DINGTALK_CLIENT_ID || "").trim();
    const clientSecret = String(process.env.DINGTALK_CLIENT_SECRET || "").trim();
    const robotCode = String(process.env.DINGTALK_REMINDER_ROBOT_CODE || clientId).trim();
    const conversationId = String(process.env.DINGTALK_REMINDER_CONVERSATION_ID || "").trim();
    const targetUserId = String(process.env.DINGTALK_REMINDER_TARGET_USER_ID || "").trim();
    const targetName = String(process.env.DINGTALK_REMINDER_TARGET_NAME || "").trim();
    if (!clientId || !clientSecret || !robotCode || !conversationId) {
      throw new Error("钉钉企业应用机器人配置不完整，请填写 Client ID、Client Secret、Robot Code 和群会话 ID。");
    }
    return sendDingTalkAppRobotMessage({
      clientId,
      clientSecret,
      robotCode,
      conversationId,
      msgKey: "sampleMarkdown",
      msgParam: {
        title,
        text: targetUserId && targetName ? `@${targetName}\n\n${text}` : text
      }
    });
  }

  const targetUserId = String(process.env.DINGTALK_REMINDER_TARGET_USER_ID || "").trim();
  const targetName = String(process.env.DINGTALK_REMINDER_TARGET_NAME || "陈奇慧").trim() || "陈奇慧";
  const botName = String(process.env.DINGTALK_REMINDER_BOT_NAME || "AI自动化机器人").trim() || "AI自动化机器人";
  const report = await sendDingTalkMarkdownMessage({ title, text });
  if (!targetUserId) return { report, mention: null };

  return {
    report,
    mention: await sendDingTalkTextMessage({
      text: buildInventoryMentionText({ targetUserId, targetName, botName }),
      atUserIds: [targetUserId]
    })
  };
}

export async function sendDingTalkMarkdownMessage({ title, text, atUserIds = [], atMobiles = [] }) {
  return sendDingTalkWebhook(buildDingTalkMarkdownPayload({ title, text, atUserIds, atMobiles }));
}

export async function sendDingTalkTextMessage({ text, atUserIds = [], atMobiles = [] }) {
  return sendDingTalkWebhook(buildDingTalkTextPayload({ text, atUserIds, atMobiles }));
}

async function sendDingTalkWebhook(payload) {
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook) {
    console.log("未配置 DINGTALK_WEBHOOK，跳过钉钉发送。");
    return { skipped: true };
  }

  const url = buildWebhookUrl(webhook, process.env.DINGTALK_SECRET);
  const response = await axios.post(url, payload);

  if (response.data?.errcode !== 0) {
    throw new Error(`钉钉发送失败：${JSON.stringify(response.data)}`);
  }

  return response.data;
}

export function buildDingTalkMarkdownPayload({ title, text, atUserIds = [], atMobiles = [] }) {
  return {
    msgtype: "markdown",
    markdown: { title, text },
    at: buildAtPayload({ atUserIds, atMobiles })
  };
}

export function buildDingTalkTextPayload({ text, atUserIds = [], atMobiles = [] }) {
  return {
    msgtype: "text",
    text: { content: text },
    at: buildAtPayload({ atUserIds, atMobiles })
  };
}

export function buildInventoryMentionText({ targetUserId, targetName, botName = "AI自动化机器人" }) {
  return `@${targetUserId} ${targetName}，请核对本次库存报告；确认后请在群里回复“@${botName} 收到”，管理员可回复“@${botName} 取消”。`;
}

function buildAtPayload({ atUserIds = [], atMobiles = [] }) {
  return {
    atUserIds: [...new Set(atUserIds.map((value) => String(value || "").trim()).filter(Boolean))],
    atMobiles: [...new Set(atMobiles.map((value) => String(value || "").trim()).filter(Boolean))],
    isAtAll: false
  };
}

export async function sendDingTalkActionCard({ title, text, singleTitle, singleUrl }) {
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook) {
    console.log("未配置 DINGTALK_WEBHOOK，跳过钉钉发送。");
    return { skipped: true };
  }

  const url = buildWebhookUrl(webhook, process.env.DINGTALK_SECRET);
  const response = await axios.post(url, {
    msgtype: "actionCard",
    actionCard: {
      title,
      text,
      single_title: singleTitle || "查看详情",
      single_url: singleUrl || ""
    }
  });

  if (response.data?.errcode !== 0) {
    throw new Error(`钉钉发送失败：${JSON.stringify(response.data)}`);
  }

  return response.data;
}

export async function sendDingTalkFeedCard({ links }) {
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook) {
    console.log("未配置 DINGTALK_WEBHOOK，跳过钉钉发送。");
    return { skipped: true };
  }

  const url = buildWebhookUrl(webhook, process.env.DINGTALK_SECRET);
  const response = await axios.post(url, {
    msgtype: "feedCard",
    feedCard: { links }
  });

  if (response.data?.errcode !== 0) {
    throw new Error(`钉钉发送失败：${JSON.stringify(response.data)}`);
  }

  return response.data;
}
