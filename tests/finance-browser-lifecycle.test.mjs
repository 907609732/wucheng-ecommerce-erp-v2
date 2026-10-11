import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('download waits settle on timeout and cancellation without opening any page', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const executable = path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const { stdout } = await promisify(execFile)(executable, ['tests/finance-browser-lifecycle.mjs'], {
    cwd: root, windowsHide: true, timeout: 30000
  });
  assert.match(stdout, /timeout, diagnostics, cancellation, reuse and isolation passed/);
});
