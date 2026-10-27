import {createHash} from 'node:crypto';

const sessions = new WeakMap();
const HEALTH = '/api/workbench/v1/health';
const fail = (code, message) => Object.assign(Error(message), {code});

function policyOf(config) {
  let origin;
  try { origin = new URL(config?.origin); } catch { throw fail('EMBEDDED_ORIGIN_INVALID', '内置私网入口地址无效'); }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.ts.net') || origin.port !== '8443' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw fail('EMBEDDED_ORIGIN_INVALID', '内置私网仅支持指定的 Tailscale HTTPS 8443 入口');
  const proxyMatch = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(config?.proxyURL || '');
  if (!proxyMatch || Number(proxyMatch[1]) > 65535) throw fail('EMBEDDED_PROXY_INVALID', '内置私网代理必须是受控的本机回环端口');
  const {proxyUsername, proxyPassword, proxyRealm, brokerId} = config;
  if (typeof proxyUsername !== 'string' || !/^[\x21-\x39\x3b-\x7e]{1,128}$/.test(proxyUsername) || typeof proxyPassword !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(proxyPassword) || typeof proxyRealm !== 'string' || !/^LingtuTailnet\/[a-f0-9]{32}$/.test(proxyRealm) || typeof brokerId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(brokerId)) throw fail('EMBEDDED_PROXY_IDENTITY_INVALID', '内置私网连接身份不完整，请重新建立连接');
  const proxyPort = Number(proxyMatch[1]), proxyURL = 'http://127.0.0.1:' + proxyPort;
  const value = {origin: origin.origin, proxyURL, proxyPort, proxyUsername, proxyPassword, proxyRealm, brokerId};
  return {...value, fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}

function bootstrap(session, policy, state, {requestImpl, timeoutMs, maxResponseBytes}) {
  return new Promise((resolve, reject) => {
    let request, settled = false, timer, authAttempts = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); state.cancel = null;
      // Keep error listeners until the aborted native request finishes: abort can
      // emit asynchronously. None of the errors includes broker credentials.
      if (error) { try { request?.abort(); } catch {} reject(error); }
      else resolve(value);
    };
    state.cancel = () => finish(fail('EMBEDDED_POLICY_SUPERSEDED', '内置私网连接策略已改变，请重试'));
    timer = setTimeout(() => finish(fail('EMBEDDED_BOOTSTRAP_TIMEOUT', '内置私网连接超时，请检查主机在线状态')), timeoutMs);
    try {
      request = requestImpl({url: policy.origin + HEALTH, method: 'GET', session, useSessionCookies: true, redirect: 'error', cache: 'no-store'});
      request.on('login', (auth, callback) => {
        const allowed = !settled && !state.superseded && authAttempts === 0 && auth?.isProxy === true && auth.host === '127.0.0.1' && auth.port === policy.proxyPort && String(auth.scheme).toLowerCase() === 'basic' && auth.realm === policy.proxyRealm;
        if (!allowed) {
          callback();
          finish(fail('EMBEDDED_PROXY_AUTH_REJECTED', '内置私网代理身份核对失败，已停止连接'));
          return;
        }
        authAttempts++;
        callback(policy.proxyUsername, policy.proxyPassword);
      });
      request.on('redirect', () => finish(fail('EMBEDDED_REDIRECT_DENIED', '内置私网入口发生跳转，已停止连接')));
      request.on('error', () => finish(fail('EMBEDDED_BOOTSTRAP_FAILED', '内置私网连接失败，请检查私网与服务器状态')));
      request.on('abort', () => finish(fail('EMBEDDED_BOOTSTRAP_ABORTED', '内置私网连接已中止')));
      request.on('response', response => {
        response.on('error', () => finish(fail('EMBEDDED_BOOTSTRAP_FAILED', '内置私网健康检查中断')));
        response.on('aborted', () => finish(fail('EMBEDDED_BOOTSTRAP_ABORTED', '内置私网健康检查已中止')));
        if (settled) return;
        if (response.statusCode !== 200) { finish(fail('EMBEDDED_HEALTH_REJECTED', '内置私网入口未通过健康检查')); return; }
        const declared = response.headers?.['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > maxResponseBytes)) { finish(fail('EMBEDDED_RESPONSE_TOO_LARGE', '内置私网健康检查返回异常')); return; }
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          const data = Buffer.from(chunk); bytes += data.length;
          if (bytes > maxResponseBytes) { finish(fail('EMBEDDED_RESPONSE_TOO_LARGE', '内置私网健康检查返回异常')); return; }
          chunks.push(data);
        });
        response.on('end', () => {
          if (settled) return;
          let health;
          try { health = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          if (health?.ok !== true || health.service !== 'wucheng-workbench' || health.protocolVersion !== 1) { finish(fail('EMBEDDED_HEALTH_INVALID', '内置私网入口不是兼容的工作台服务')); return; }
          finish(null, Object.freeze({origin: policy.origin, brokerId: policy.brokerId}));
        });
      });
      request.end();
    } catch { finish(fail('EMBEDDED_BOOTSTRAP_FAILED', '内置私网连接初始化失败')); }
  });
}

// Use only a dedicated per-server Session. This helper never installs a global
// app.login handler or changes webRequest hooks, TLS verification or OS proxy.
// Caller retains the exact-origin navigation/request gate for renderer traffic.
export function prepareEmbeddedSession(session, config, {requestImpl, timeoutMs = 12000, maxResponseBytes = 64 * 1024} = {}) {
  if (!session || typeof session.setProxy !== 'function' || typeof session.closeAllConnections !== 'function' || typeof session.clearAuthCache !== 'function' || typeof requestImpl !== 'function') throw fail('EMBEDDED_SESSION_INVALID', '缺少内置私网会话初始化能力');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1024 * 1024) throw fail('EMBEDDED_LIMIT_INVALID', '内置私网连接限制无效');
  const policy = policyOf(config), previous = sessions.get(session);
  if (previous?.fingerprint === policy.fingerprint) return previous.ready;
  if (previous) { previous.superseded = true; previous.cancel?.(); }
  const state = {fingerprint: policy.fingerprint, superseded: false, cancel: null, ready: null};
  state.ready = Promise.resolve(previous?.ready).catch(() => {}).then(async () => {
    if (state.superseded) throw fail('EMBEDDED_POLICY_SUPERSEDED', '内置私网连接策略已改变，请重试');
    try {
      await session.closeAllConnections();
      await session.clearAuthCache();
      await session.setProxy({mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:' + policy.proxyPort + ';https=127.0.0.1:' + policy.proxyPort, proxyBypassRules: '<-loopback>'});
    } catch { throw fail('EMBEDDED_SESSION_CONFIGURATION_FAILED', '内置私网专属会话配置失败'); }
    if (state.superseded) throw fail('EMBEDDED_POLICY_SUPERSEDED', '内置私网连接策略已改变，请重试');
    return bootstrap(session, policy, state, {requestImpl, timeoutMs, maxResponseBytes});
  });
  sessions.set(session, state);
  return state.ready;
}

// Explicit user retry or broker teardown. Retains the fixed proxy: no direct or
// system-proxy fallback can occur while a replacement policy is being prepared.
export async function resetEmbeddedSession(session) {
  const previous = sessions.get(session);
  if (previous) { previous.superseded = true; previous.cancel?.(); }
  const state = {fingerprint: null, superseded: false, cancel: null, ready: null};
  state.ready = Promise.resolve(previous?.ready).catch(() => {}).then(async () => {
    await session.closeAllConnections();
    await session.clearAuthCache();
  });
  sessions.set(session, state);
  try { await state.ready; }
  finally { if (sessions.get(session) === state) sessions.delete(session); }
}

export async function fetchFromEmbeddedSession(session, input, options, config, dependencies) {
  const policy = policyOf(config);
  let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { throw fail('EMBEDDED_TARGET_DENIED', '内置私网请求地址无效'); }
  if (url.origin !== policy.origin || url.username || url.password) throw fail('EMBEDDED_TARGET_DENIED', '内置私网请求不属于当前工作台');
  if (options?.redirect && options.redirect !== 'error') throw fail('EMBEDDED_REDIRECT_DENIED', '内置私网请求不能跟随跳转');
  await prepareEmbeddedSession(session, config, dependencies);
  return session.fetch(input, {...options, redirect: 'error'});
}
