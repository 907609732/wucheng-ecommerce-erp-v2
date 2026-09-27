import crypto from "node:crypto";

const SESSION_COOKIE = "__Host-erp_dingtalk";
const STATE_COOKIE = "__Host-erp_dingtalk_state";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

export function dingtalkAuthConfig(env = process.env) {
  return {
    clientId: String(env.DINGTALK_CLIENT_ID || "").trim(),
    clientSecret: String(env.DINGTALK_CLIENT_SECRET || "").trim(),
    redirectUri: String(env.DINGTALK_REDIRECT_URI || "").trim(),
    sessionSecret: String(env.DINGTALK_SESSION_SECRET || "").trim(),
    allowedIds: splitIds(env.DINGTALK_ALLOWED_USER_IDS),
    adminIds: splitIds(env.DINGTALK_ADMIN_USER_IDS)
  };
}

export function isDingtalkAuthConfigured(config = dingtalkAuthConfig()) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri && config.sessionSecret);
}

export function createDingtalkAuthHandlers({ env = process.env, fetchImpl = fetch } = {}) {
  const config = dingtalkAuthConfig(env);

  function start(req, res) {
    if (!isDingtalkAuthConfigured(config)) return authUnavailable(res);
    const state = crypto.randomBytes(24).toString("base64url");
    setCookie(res, STATE_COOKIE, signValue({ state, exp: unixNow() + STATE_TTL_SECONDS }, config.sessionSecret), STATE_TTL_SECONDS);
    const params = new URLSearchParams({
      redirect_uri: config.redirectUri,
      response_type: "code",
      client_id: config.clientId,
      scope: "openid",
      state,
      prompt: "consent"
    });
    return res.redirect(`https://login.dingtalk.com/oauth2/auth?${params}`);
  }

  async function callback(req, res) {
    try {
      if (!isDingtalkAuthConfigured(config)) return authUnavailable(res);
      const stateCookie = readSignedCookie(req, STATE_COOKIE, config.sessionSecret);
      if (!stateCookie || !safeEqual(stateCookie.state, req.query.state)) throw new Error("登录状态已过期，请重新发起钉钉登录。");
      const code = String(req.query.code || "").trim();
      if (!code) throw new Error("钉钉未返回登录授权码。");

      const tokenResponse = await fetchImpl("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: config.clientId, clientSecret: config.clientSecret, code, grantType: "authorization_code" }),
        signal: AbortSignal.timeout(8000)
      });
      const token = await readApiResponse(tokenResponse, "获取钉钉用户令牌失败");
      const userResponse = await fetchImpl("https://api.dingtalk.com/v1.0/contact/users/me", {
        headers: { "x-acs-dingtalk-access-token": token.accessToken },
        signal: AbortSignal.timeout(8000)
      });
      const user = await readApiResponse(userResponse, "获取钉钉用户信息失败");
      const identity = normalizeDingtalkUser(user, config);
      if (config.allowedIds.size && !matchesIdentity(identity, config.allowedIds)) throw new Error("当前钉钉账号不在 ERP 授权名单中。");

      const session = { ...identity, exp: unixNow() + SESSION_TTL_SECONDS };
      setCookie(res, SESSION_COOKIE, signValue(session, config.sessionSecret), SESSION_TTL_SECONDS);
      clearCookie(res, STATE_COOKIE);
      return res.redirect("/?module=unpack&login=success");
    } catch (error) {
      clearCookie(res, STATE_COOKIE);
      return res.status(401).send(loginResultPage(error.message));
    }
  }

  function me(req, res) {
    const user = currentUser(req, config);
    return res.json({ ok: true, data: { configured: isDingtalkAuthConfigured(config), authenticated: Boolean(user), user } });
  }

  function logout(_req, res) {
    clearCookie(res, SESSION_COOKIE);
    return res.json({ ok: true });
  }

  function requireUser(req, res, next) {
    if (!isDingtalkAuthConfigured(config)) return authUnavailable(res);
    const user = currentUser(req, config);
    if (!user) return res.status(401).json({ ok: false, error: "请先使用钉钉登录。", loginUrl: "/api/auth/dingtalk/start" });
    req.authUser = user;
    return next();
  }

  function requireAdmin(req, res, next) {
    return requireUser(req, res, () => {
      if (req.authUser.role !== "admin") return res.status(403).json({ ok: false, error: "此操作仅限管理员。" });
      return next();
    });
  }

  return { config, start, callback, me, logout, requireUser, requireAdmin };
}

export function normalizeDingtalkUser(user, config) {
  const identity = {
    userId: String(user.unionId || user.openId || user.userId || "").trim(),
    unionId: String(user.unionId || "").trim(),
    openId: String(user.openId || "").trim(),
    name: String(user.nick || user.name || "钉钉用户").trim() || "钉钉用户",
    avatarUrl: String(user.avatarUrl || "").trim(),
    role: "operator"
  };
  if (!identity.userId) throw new Error("钉钉用户信息缺少唯一标识。");
  if (matchesIdentity(identity, config.adminIds)) identity.role = "admin";
  return identity;
}

export function signValue(payload, secret) {
  if (!secret) throw new Error("DINGTALK_SESSION_SECRET 未配置。");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyValue(value, secret, now = unixNow()) {
  const [encoded, signature, extra] = String(value || "").split(".");
  if (!encoded || !signature || extra || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return Number(payload.exp) > now ? payload : null;
  } catch {
    return null;
  }
}

function currentUser(req, config) {
  const value = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  return verifyValue(value, config.sessionSecret);
}

function readSignedCookie(req, name, secret) {
  return verifyValue(parseCookies(req.headers.cookie || "")[name], secret);
}

function parseCookies(header) {
  return String(header || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function setCookie(res, name, value, maxAge) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

function splitIds(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function matchesIdentity(identity, ids) {
  return [identity.userId, identity.unionId, identity.openId].some((value) => value && ids.has(value));
}

async function readApiResponse(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.errorMessage || `${fallback}（HTTP ${response.status}）`);
  return payload;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authUnavailable(res) {
  return res.status(503).json({ ok: false, error: "钉钉登录尚未完成服务器配置。" });
}

function loginResultPage(message) {
  const safe = String(message || "登录失败").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  return `<!doctype html><meta charset="utf-8"><title>钉钉登录失败</title><p>钉钉登录失败：${safe}</p><p><a href="/">返回 ERP</a></p>`;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}
