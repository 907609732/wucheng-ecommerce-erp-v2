import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureTailnetSessionDirect,fetchFromTailnetSession} from '../desktop/workbench-client/tailnet-session.mjs';

test('Tailnet fetch waits for proxy configuration and concurrent callers share initialization', async () => {
  let release, configurations = 0;
  const calls = [], response = {status: 200};
  const session = {
    setProxy(config) {
      configurations++;
      assert.deepEqual(config, {mode: 'direct'});
      return new Promise(resolve => { release = resolve; });
    },
    async fetch(...args) { calls.push(args); return response; }
  };
  const options = {headers: {Origin: 'https://fixture.test-tail.ts.net:8443'}};
  const first = fetchFromTailnetSession(session, 'https://fixture.test-tail.ts.net:8443/session', options);
  const second = fetchFromTailnetSession(session, 'https://fixture.test-tail.ts.net:8443/modules');
  const viewReady = ensureTailnetSessionDirect(session);
  assert.equal(viewReady, ensureTailnetSessionDirect(session));
  await Promise.resolve();
  assert.equal(configurations, 1);
  assert.deepEqual(calls, []);
  release();
  assert.deepEqual(await Promise.all([first, second]), [response, response]);
  await viewReady;
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], options);
  await fetchFromTailnetSession(session, 'https://fixture.test-tail.ts.net:8443/again');
  assert.equal(configurations, 1, 'switching channels must not reset an active shared Session');
});

test('failed private Session initialization blocks all callers without proxy fallback', async () => {
  const cause = Error('isolated setProxy failure');
  let requests = 0, configurations = 0;
  const session = {
    async setProxy() { configurations++; throw cause; },
    async fetch() { requests++; }
  };
  const rejected = error => error.code === 'TAILNET_SESSION_INITIALIZATION_FAILED' && error.cause === cause;
  await assert.rejects(fetchFromTailnetSession(session, 'https://fixture.test-tail.ts.net:8443'), rejected);
  await assert.rejects(ensureTailnetSessionDirect(session), rejected);
  await assert.rejects(fetchFromTailnetSession(session, 'https://fixture.test-tail.ts.net:8443'), rejected);
  assert.equal(requests, 0);
  assert.equal(configurations, 1);
});

