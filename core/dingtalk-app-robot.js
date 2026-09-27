import axios from "axios";

const DINGTALK_ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const DINGTALK_GROUP_MESSAGE_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";

export async function sendDingTalkAppRobotMessage({
  clientId,
  clientSecret,
  robotCode,
  conversationId,
  msgKey,
  msgParam
}) {
  const accessToken = await getDingTalkAppAccessToken({ clientId, clientSecret });
  try {
    const response = await axios.post(
      DINGTALK_GROUP_MESSAGE_URL,
      buildDingTalkAppRobotGroupPayload({ robotCode, conversationId, msgKey, msgParam }),
      { headers: { "x-acs-dingtalk-access-token": accessToken } }
    );
    return response.data;
  } catch (error) {
    throw buildDingTalkApiError(error, "发送群消息");
  }
}

async function getDingTalkAppAccessToken({ clientId, clientSecret }) {
  try {
    const response = await axios.post(DINGTALK_ACCESS_TOKEN_URL, {
      appKey: clientId,
      appSecret: clientSecret
    });
    const accessToken = String(response.data?.accessToken || "").trim();
    if (!accessToken) throw new Error("钉钉未返回 accessToken");
    return accessToken;
  } catch (error) {
    throw buildDingTalkApiError(error, "获取企业应用 accessToken");
  }
}

export function buildDingTalkAppRobotGroupPayload({ robotCode, conversationId, msgKey, msgParam }) {
  // DingTalk OrgGroupSend only accepts the group identity and message fields.
  // userIds belongs to one-to-one delivery and makes this group endpoint reject the request.
  return {
    robotCode: String(robotCode || "").trim(),
    openConversationId: String(conversationId || "").trim(),
    msgKey: String(msgKey || "").trim(),
    msgParam: JSON.stringify(msgParam)
  };
}

export function buildDingTalkApiError(error, operation) {
  const status = Number(error?.response?.status || 0);
  const data = error?.response?.data;
  const code = firstDiagnosticValue(data, ["code", "errorCode", "errcode"]);
  const message = firstDiagnosticValue(data, ["message", "errorMessage", "errmsg"])
    || (error?.response ? "钉钉接口拒绝了请求" : String(error?.message || "未知错误"));
  const requestId = firstDiagnosticValue(data, ["requestId", "request_id", "traceId"]);
  const parts = [`钉钉${operation}失败`];
  if (status) parts.push(`HTTP ${status}`);
  if (code) parts.push(`错误码 ${safeDiagnosticText(code)}`);
  parts.push(safeDiagnosticText(message));
  if (requestId) parts.push(`Request ID ${safeDiagnosticText(requestId)}`);
  return new Error(parts.join("；"));
}

function firstDiagnosticValue(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const current = value[key];
    if (current !== undefined && current !== null && String(current).trim()) return String(current).trim();
  }
  return "";
}

function safeDiagnosticText(value) {
  return String(value || "")
    .replace(/(access[_-]?token|app[_-]?secret|client[_-]?secret|webhook|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}
