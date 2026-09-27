import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDingTalkApiError,
  buildDingTalkAppRobotGroupPayload
} from "../core/dingtalk-app-robot.js";

test("enterprise robot group payload only includes fields accepted by the DingTalk group API", () => {
  const payload = buildDingTalkAppRobotGroupPayload({
    robotCode: " robot-code ",
    conversationId: " cid-group ",
    msgKey: " sampleMarkdown ",
    msgParam: { title: "库存日报", text: "库存正文" },
    userIds: ["user-1"]
  });

  assert.deepEqual(payload, {
    robotCode: "robot-code",
    openConversationId: "cid-group",
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: "库存日报", text: "库存正文" })
  });
  assert.equal("userIds" in payload, false);
});

test("DingTalk API errors keep actionable codes while redacting sensitive values", () => {
  const error = buildDingTalkApiError({
    response: {
      status: 400,
      data: {
        code: "invalidParameter.robotCode.auth",
        message: "clientSecret=very-secret appKey mismatch",
        requestId: "request-123"
      }
    }
  }, "发送群消息");

  assert.match(error.message, /HTTP 400/);
  assert.match(error.message, /invalidParameter\.robotCode\.auth/);
  assert.match(error.message, /Request ID request-123/);
  assert.doesNotMatch(error.message, /very-secret/);
});
