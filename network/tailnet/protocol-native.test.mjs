import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

// Explicit executable input; this fixture never sends start/login, contacts a
// Tailnet, or reuses a real user profile. Build separately with the pinned SDK.
const binary = process.env.TAILNET_PROTOTYPE_BINARY;

function owner(binaryPath) {
  const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let stderr = '';
  let sequence = 0;
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { for (const item of pending.values()) item.reject(new Error('non-JSON protocol output')); return; }
    const item = pending.get(response.id);
    if (item) { clearTimeout(item.timeout); pending.delete(response.id); item.resolve(response); }
  });
  return {
    child, exit,
    get stderr() { return stderr; },
    request(op, fields = {}) {
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('inert protocol request timed out')); }, 10000);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify({ v: 1, id, op, ...fields })}\n`);
      });
    },
    async finish() {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 10000);
      try { return await exit; } finally { clearTimeout(timeout); lines.close(); }
    },
  };
}

test('actual Go child init is inert, private, exclusive, and releases on EOF', { skip: !binary, timeout: 60000 }, async () => {
  assert.ok(path.isAbsolute(binary), 'provide an absolute explicit prototype binary path');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lingtu-tsnet-inert-'));
  const stateDir = path.join(fixture, 'synthetic-private-node');
  const credentials = () => ({ nonce: randomBytes(32).toString('hex'), proxyPassword: randomBytes(32).toString('hex') });
  const config = { origin: 'https://workbench.synthetic-tail.ts.net:8443', stateDir, hostname: 'lingtu-synthetic-inert', ...credentials() };
  const first = owner(binary);
  const second = owner(binary);
  let third;
  try {
    const initialized = await first.request('init', config);
    assert.equal(initialized.ok, true);
    assert.equal(initialized.result.state, 'stopped');
    assert.match(initialized.result.proxyURL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(initialized.result.proxyRealm, /^LingtuTailnet\/[a-f0-9]{32}$/);
    assert.equal(initialized.result.proxyUsername, 'workbench');
    const serialized = JSON.stringify(initialized);
    assert.equal(serialized.includes(config.nonce), false);
    assert.equal(serialized.includes(config.proxyPassword), false);

    const conflict = await second.request('init', { ...config, ...credentials() });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'STATE_IN_USE');
    assert.deepEqual(await fs.readdir(stateDir), ['sidecar.lock'], 'inert init must not create tsnet keys/logs or start backend');

    const denied = await first.request('status', { nonce: 'invalid' });
    assert.equal(denied.error.code, 'UNAUTHORIZED');
    const status = await first.request('status', { nonce: config.nonce });
    assert.equal(status.result.state, 'stopped');
    assert.equal((await first.finish()).code, 0);
    assert.equal(first.stderr, '');
    await second.finish();

    third = owner(binary);
    const reopened = await third.request('init', { ...config, ...credentials() });
    assert.equal(reopened.ok, true, 'EOF must release exclusive Windows lock without deleting it');
    assert.deepEqual(await fs.readdir(stateDir), ['sidecar.lock']);
    assert.equal((await third.finish()).code, 0);
    assert.equal(third.stderr, '');
  } finally {
    await Promise.allSettled([first.finish(), second.finish(), third?.finish()]);
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
