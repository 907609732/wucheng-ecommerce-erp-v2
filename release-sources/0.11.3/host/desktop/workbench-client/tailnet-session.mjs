const readiness = new WeakMap();

// A provider switch must not reuse an earlier DIRECT decision after this
// dedicated Session has been configured for an embedded proxy.
export function forgetDirectTailnetSession(session) { readiness.delete(session); }

// Call only for the workbench's dedicated, per-server Session. Public/default
// sessions keep their normal proxy policy. Direct HTTP does not bypass OS TUNs.
export function ensureTailnetSessionDirect(session) {
  let ready = readiness.get(session);
  if (!ready) {
    ready = Promise.resolve().then(() => session.setProxy({mode: 'direct'})).catch(cause => {
      throw Object.assign(Error('私网连接初始化失败，请重新打开工作台后重试'), {
        code: 'TAILNET_SESSION_INITIALIZATION_FAILED', cause
      });
    });
    // Channels and views share a Session; configure it once, before any request.
    // A failure remains closed instead of silently using the system proxy.
    readiness.set(session, ready);
  }
  return ready;
}

export async function fetchFromTailnetSession(session, input, options) {
  await ensureTailnetSessionDirect(session);
  return session.fetch(input, options);
}
