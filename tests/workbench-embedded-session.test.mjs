import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {prepareEmbeddedSession, resetEmbeddedSession, fetchFromEmbeddedSession} from '../desktop/workbench-client/embedded-session.mjs';

const config = {origin: 'https://fixture.test-tail.ts.net:8443', proxyURL: 'http://127.0.0.1:31929', proxyUsername: 'workbench', proxyPassword: 'isolated-secret', proxyRealm: 'LingtuTailnet/' + 'a'.repeat(32), brokerId: 'isolated-child-1'};
const health = {ok: true, service: 'wucheng-workbench', protocolVersion: 1};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(action = request => request.respond(health)) {
  const events = [], requests = [], fetches = [];
  const session = {
    async closeAllConnections() { events.push('close'); },
    async clearAuthCache() { events.push('clear-auth'); },
    async setProxy(value) { events.push(value); },
    async fetch(...args) { fetches.push(args); return {status: 200}; }
  };
  const requestImpl = options => {
    const request = new EventEmitter(); request.options = options; request.aborts = 0;
    request.abort = () => { request.aborts++; queueMicrotask(() => request.emit('abort')); };
    request.end = () => queueMicrotask(() => action(request));
    request.respond = (data, {status = 200, headers = {}, body = JSON.stringify(data)} = {}) => {
      const response = new EventEmitter(); response.statusCode = status; response.headers = headers;
      request.emit('response', response); response.emit('data', Buffer.from(body)); response.emit('end');
    };
    request.auth = (changes = {}) => { let args; request.emit('login', {isProxy: true, host: '127.0.0.1', port: 31929, scheme: 'basic', realm: config.proxyRealm, ...changes}, (...value) => { args = value; }); return args; };
    requests.push(request); return request;
  };
  return {session, events, requests, fetches, dependencies: {requestImpl, timeoutMs: 1000}};
}

test('dedicated bootstrap uses one bounded GET and shares initialization without global auth hooks', async () => {
  const f = fixture(request => { assert.deepEqual(request.auth(), [config.proxyUsername, config.proxyPassword]); request.respond(health); });
  const first = prepareEmbeddedSession(f.session, config, f.dependencies);
  assert.equal(first, prepareEmbeddedSession(f.session, {...config}, f.dependencies));
  assert.deepEqual(await first, {origin: config.origin, brokerId: config.brokerId});
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].options, {url: config.origin + '/api/workbench/v1/health', method: 'GET', session: f.session, useSessionCookies: true, redirect: 'error', cache: 'no-store'});
  assert.deepEqual(f.events, ['close', 'clear-auth', {mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:31929;https=127.0.0.1:31929', proxyBypassRules: '<-loopback>'}]);
  assert.equal(prepareEmbeddedSession(f.session, config, f.dependencies), first);
  const ordinary = fixture(); assert.equal(ordinary.events.length, 0);
});

test('policy and limits reject untrusted URL/identity before touching any Session', () => {
  const f = fixture();
  for (const patch of [{origin: 'http://fixture.ts.net:8443'}, {origin: 'https://fixture.ts.net'}, {origin: config.origin + '/apps/purchase'}, {origin: 'https://user:pass@fixture.ts.net:8443'}, {origin: 'https://fixture.example.com:8443'}, {proxyURL: 'http://127.1:31929'}, {proxyURL: 'http://localhost:31929'}, {proxyURL: 'http://127.0.0.1:31929?fallback=direct'}, {proxyURL: 'http://127.0.0.1:65536'}, {proxyUsername: 'bad:user'}, {proxyRealm: 'workbench'}, {proxyPassword: ''}, {brokerId: ''}]) assert.throws(() => prepareEmbeddedSession(f.session, {...config, ...patch}, f.dependencies), /^Error:/);
  assert.throws(() => prepareEmbeddedSession(f.session, config, {...f.dependencies, timeoutMs: 0}), {code: 'EMBEDDED_LIMIT_INVALID'});
  assert.deepEqual(f.events, []); assert.equal(f.requests.length, 0);
});

for (const [name, challenge] of Object.entries({origin: {isProxy: false}, host: {host: 'localhost'}, port: {port: 31930}, scheme: {scheme: 'digest'}, realm: {realm: 'LingtuTailnet/' + 'b'.repeat(32)}})) test('proxy authentication denies mismatched ' + name + ' without supplying credentials', async () => {
  const f = fixture(request => assert.deepEqual(request.auth(challenge), []));
  await assert.rejects(prepareEmbeddedSession(f.session, config, f.dependencies), {code: 'EMBEDDED_PROXY_AUTH_REJECTED'});
  assert.equal(f.requests[0].aborts, 1);
});

test('bad credentials cannot cause repeated credential callbacks or silent direct fallback', async () => {
  const f = fixture(request => { assert.deepEqual(request.auth(), [config.proxyUsername, config.proxyPassword]); assert.deepEqual(request.auth(), []); });
  const first = prepareEmbeddedSession(f.session, config, f.dependencies);
  await assert.rejects(first, {code: 'EMBEDDED_PROXY_AUTH_REJECTED'});
  assert.equal(first, prepareEmbeddedSession(f.session, config, f.dependencies));
  assert.equal(f.requests.length, 1); assert(!f.events.some(event => event.mode === 'direct'));
});

test('explicit broker/port/credential policy changes close old connections and clear cached proxy credentials', async () => {
  const f = fixture();
  await prepareEmbeddedSession(f.session, config, f.dependencies);
  for (const patch of [{brokerId: 'isolated-child-2'}, {proxyURL: 'http://127.0.0.1:31930'}, {proxyPassword: 'rotated-secret'}, {proxyRealm: 'LingtuTailnet/' + 'b'.repeat(32)}]) await prepareEmbeddedSession(f.session, {...config, ...patch}, f.dependencies);
  assert.equal(f.requests.length, 5); assert.equal(f.events.filter(event => event === 'close').length, 5); assert.equal(f.events.filter(event => event === 'clear-auth').length, 5);
});

test('superseding an in-flight bootstrap cancels it and serializes replacement configuration', async () => {
  const f = fixture(request => { if (f.requests.length > 1) request.respond(health); });
  const first = prepareEmbeddedSession(f.session, config, f.dependencies); const rejected = assert.rejects(first, {code: 'EMBEDDED_POLICY_SUPERSEDED'});
  await tick();
  const second = prepareEmbeddedSession(f.session, {...config, brokerId: 'next-child'}, f.dependencies);
  await rejected; await second;
  assert.equal(f.requests[0].aborts, 1); assert.equal(f.requests.length, 2);
});

for (const [name, action, code, limits] of [
  ['timeout', () => {}, 'EMBEDDED_BOOTSTRAP_TIMEOUT', {timeoutMs: 15}],
  ['TLS/network error', request => request.emit('error', Error('sensitive native detail')), 'EMBEDDED_BOOTSTRAP_FAILED'],
  ['redirect', request => request.emit('redirect', 302, 'GET', 'https://unlisted.ts.net:8443'), 'EMBEDDED_REDIRECT_DENIED'],
  ['HTTP failure', request => request.respond(health, {status: 503}), 'EMBEDDED_HEALTH_REJECTED'],
  ['incompatible health', request => request.respond({...health, protocolVersion: 2}), 'EMBEDDED_HEALTH_INVALID'],
  ['invalid JSON', request => request.respond(null, {body: 'not json'}), 'EMBEDDED_HEALTH_INVALID'],
  ['declared oversized body', request => request.respond(health, {headers: {'content-length': '2048'}}), 'EMBEDDED_RESPONSE_TOO_LARGE', {maxResponseBytes: 64}],
  ['streamed oversized body', request => request.respond(health), 'EMBEDDED_RESPONSE_TOO_LARGE', {maxResponseBytes: 16}]
]) test('bootstrap fails closed on ' + name, async () => {
  const f = fixture(action);
  await assert.rejects(prepareEmbeddedSession(f.session, config, {...f.dependencies, ...limits}), error => error.code === code && !error.message.includes(config.proxyPassword) && !error.message.includes('sensitive native detail'));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].aborts, 1); assert.equal(f.fetches.length, 0);
});

test('configuration failure remains closed; explicit retry resets auth without switching to direct', async () => {
  const f = fixture(); let denied = true;
  f.session.setProxy = async value => { f.events.push(value); if (denied) throw Error('setProxy error'); };
  await assert.rejects(prepareEmbeddedSession(f.session, config, f.dependencies), {code: 'EMBEDDED_SESSION_CONFIGURATION_FAILED'});
  assert.equal(f.requests.length, 0); denied = false;
  await resetEmbeddedSession(f.session);
  await prepareEmbeddedSession(f.session, config, f.dependencies);
  assert.equal(f.requests.length, 1); assert(!f.events.some(event => event.mode === 'direct'));
});

test('concurrent reset and replacement cannot clear a newly initialized proxy Session', async () => {
  const f = fixture(); await prepareEmbeddedSession(f.session, config, f.dependencies);
  const resetting = resetEmbeddedSession(f.session), replacing = prepareEmbeddedSession(f.session, {...config, brokerId: 'replacement'}, f.dependencies);
  await Promise.all([resetting, replacing]); const events = f.events.length;
  await prepareEmbeddedSession(f.session, {...config, brokerId: 'replacement'}, f.dependencies);
  assert.equal(f.events.length, events); assert.equal(f.requests.length, 2);
});

test('fetch wrapper restricts exact origin, blocks redirects and sends each mutation once after read-only bootstrap', async () => {
  const f = fixture();
  await assert.rejects(fetchFromEmbeddedSession(f.session, 'https://unlisted.test-tail.ts.net:8443/api', {}, config, f.dependencies), {code: 'EMBEDDED_TARGET_DENIED'});
  await assert.rejects(fetchFromEmbeddedSession(f.session, config.origin + '/api', {redirect: 'follow'}, config, f.dependencies), {code: 'EMBEDDED_REDIRECT_DENIED'});
  assert.equal(f.requests.length, 0);
  const options = {method: 'POST', body: 'one mutation', headers: {'Idempotency-Key': 'fixture'}};
  await fetchFromEmbeddedSession(f.session, config.origin + '/api/workbench/v1/modules/purchase/api/orders', options, config, f.dependencies);
  assert.equal(f.fetches.length, 1); assert.deepEqual(f.fetches[0][1], {...options, redirect: 'error'});
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.method, 'GET');
});
