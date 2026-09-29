export const DEFAULT_SETTINGS = Object.freeze({
  scheduleEnabled: false,
  scheduleTime: "22:00",
  monthlySalesEnabled: false,
  monthlySalesTime: "22:00",
  startAtLogin: false,
  lowStockThreshold: 10,
  deliveryMode: "app",
  dingtalkRobotCode: "",
  dingtalkConversationId: "",
  dingtalkTargetUserId: "",
  dingtalkTargetName: "",
  cainiaoUsername: "",
  trustedExtensionIds: []
});

export const SECRET_FIELDS = Object.freeze([
  "cainiaoPassword",
  "dingtalkClientId",
  "dingtalkClientSecret",
  "dingtalkWebhook",
  "dingtalkWebhookSecret",
  "githubUpdateToken"
]);

export const EDITABLE_SECRET_FIELDS = Object.freeze([
  "cainiaoPassword",
  "dingtalkClientId",
  "dingtalkClientSecret",
  "dingtalkWebhook",
  "dingtalkWebhookSecret"
]);

export function normalizeSettings(input = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...input };
  settings.scheduleEnabled = Boolean(settings.scheduleEnabled);
  settings.monthlySalesEnabled = Boolean(settings.monthlySalesEnabled);
  settings.startAtLogin = Boolean(settings.startAtLogin);
  settings.deliveryMode = settings.deliveryMode === "webhook" ? "webhook" : "app";
  settings.scheduleTime = String(settings.scheduleTime || "").trim();
  settings.monthlySalesTime = String(settings.monthlySalesTime || "").trim();
  settings.lowStockThreshold = Number(settings.lowStockThreshold);
  settings.trustedExtensionIds = Array.isArray(settings.trustedExtensionIds)
    ? [...new Set(settings.trustedExtensionIds.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))].sort()
    : [];
  for (const key of [
    "dingtalkRobotCode",
    "dingtalkConversationId",
    "dingtalkTargetUserId",
    "dingtalkTargetName",
    "cainiaoUsername"
  ]) settings[key] = String(settings[key] || "").trim();
  return settings;
}

export function validateSettings(settings, secretFlags = {}) {
  const value = normalizeSettings(settings);
  const errors = [
    ...validateAutomationSettings(value).errors,
    ...validateCainiaoSettings(value, secretFlags).errors,
    ...validateDingTalkSettings(value, secretFlags).errors
  ];
  return { ok: errors.length === 0, errors, value };
}

export function validateAutomationSettings(settings) {
  const value = normalizeSettings(settings);
  const errors = [];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.scheduleTime)) {
    errors.push("执行时间必须是 HH:mm 格式");
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.monthlySalesTime)) {
    errors.push("月销量执行时间必须是 HH:mm 格式");
  }
  if (!Number.isInteger(value.lowStockThreshold) || value.lowStockThreshold < 0 || value.lowStockThreshold > 999999) {
    errors.push("低库存阈值必须是 0 到 999999 的整数");
  }
  return { ok: errors.length === 0, errors, value };
}

export function validateDingTalkSettings(settings, secretFlags = {}) {
  const value = normalizeSettings(settings);
  const errors = [];
  if (value.deliveryMode === "app") {
    if (!secretFlags.dingtalkClientId) errors.push("请填写钉钉 Client ID");
    if (!secretFlags.dingtalkClientSecret) errors.push("请填写钉钉 Client Secret");
    if (!value.dingtalkRobotCode) errors.push("请填写钉钉 Robot Code");
    if (!value.dingtalkConversationId) errors.push("请填写钉钉群会话 ID");
  } else if (!secretFlags.dingtalkWebhook) {
    errors.push("请填写钉钉 Webhook 地址");
  }
  return { ok: errors.length === 0, errors, value };
}

export function validateCainiaoSettings(settings, secretFlags = {}) {
  const value = normalizeSettings(settings);
  const errors = [];
  if (!value.cainiaoUsername) errors.push("请填写菜鸟账号");
  if (!secretFlags.cainiaoPassword) errors.push("请填写菜鸟密码");
  return { ok: errors.length === 0, errors, value };
}

export function nextRunAt(scheduleTime, now = new Date()) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(scheduleTime || ""));
  if (!match) throw new Error("无效的每日执行时间");
  const result = new Date(now);
  result.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (result <= now) result.setDate(result.getDate() + 1);
  return result;
}

export function nextMonthlyRunAt(scheduleTime, now = new Date()) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(scheduleTime || ""));
  if (!match) throw new Error("无效的月销量执行时间");
  const result = new Date(now);
  result.setDate(1);
  result.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (result <= now) result.setMonth(result.getMonth() + 1, 1);
  return result;
}
