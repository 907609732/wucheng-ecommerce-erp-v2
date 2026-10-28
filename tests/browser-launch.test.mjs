import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserLaunchOptions} from '../core/browser-launch.js';

test('independent installations still use system Chrome', () => {
  assert.deepEqual(browserLaunchOptions(''), {channel:'chrome'});
});
test('missing or directory runtime is rejected instead of silently using another browser', () => {
  assert.throws(() => browserLaunchOptions(path.join(os.tmpdir(),'missing-browser-'+process.pid)), /配套浏览器文件不可用/);
  assert.throws(() => browserLaunchOptions(os.tmpdir()), /配套浏览器文件不可用/);
});
test('browser inside a redirected directory resolves to its physical file', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-path-'));
  try {
    const physical=path.join(root,'physical'),alias=path.join(root,'redirected');
    fs.mkdirSync(physical);fs.writeFileSync(path.join(physical,'browser.exe'),'fixture');
    fs.symlinkSync(physical,alias,process.platform==='win32'?'junction':'dir');
    assert.equal(browserLaunchOptions(path.join(alias,'browser.exe')).executablePath,fs.realpathSync.native(path.join(physical,'browser.exe')));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
