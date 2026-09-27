import assert from "node:assert/strict";
import test from "node:test";
import { dingtalkAuthConfig, normalizeDingtalkUser, signValue, verifyValue } from "../core/erp/dingtalk-auth.js";

test("signs, verifies and expires DingTalk sessions", () => {
  const secret = "test-secret-that-is-long-enough-for-hmac";
  const token = signValue({ userId: "u1", exp: 200 }, secret);
  assert.equal(verifyValue(token, secret, 100).userId, "u1");
  assert.equal(verifyValue(token, secret, 201), null);
  assert.equal(verifyValue(`${token}x`, secret, 100), null);
});

test("assigns admin role from unionId or openId", () => {
  const config = dingtalkAuthConfig({ DINGTALK_ADMIN_USER_IDS: "union-admin, open-admin" });
  assert.equal(normalizeDingtalkUser({ unionId: "union-admin", nick: "管理员" }, config).role, "admin");
  assert.equal(normalizeDingtalkUser({ openId: "open-user", nick: "操作员" }, config).role, "operator");
});
