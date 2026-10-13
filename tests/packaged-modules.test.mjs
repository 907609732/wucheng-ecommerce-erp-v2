import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listPackage, extractFile } from '@electron/asar';

test('Windows package excludes removed modules and includes retained invoice resources', () => {
  const resources = path.resolve('dist/win-unpacked/resources');
  const archive = path.join(resources, 'app.asar');
  const files = listPackage(archive).map(name => name.replaceAll('\\', '/'));
  assert.equal(files.some(name => /\/desktop\/(?:shared\/|renderer\/(?:vendor\/)?)?(?:business|finance|purchase)[-.]/.test(name)), false);
  assert.equal(files.some(name => name.includes('/@univerjs/') || name.includes('/fast-formula-parser/')), false);
  for (const name of ['desktop/shared/pdd-buyer.mjs', 'desktop/shared/pdd-monthly-export.mjs', 'desktop/shared/invoice-browser.mjs']) assert.ok(files.includes('/' + name), name);
  const packaged = JSON.parse(extractFile(archive, 'package.json').toString());
  assert.equal(packaged.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  const invoice = path.join(resources, 'invoice-module');
  for (const name of ['assistant.py', 'invoice_watch.py', 'run.py', '模板/新福通通用开票申请单模板.xlsx']) assert.ok(fs.existsSync(path.join(invoice, name)), name);
  for (const name of ['config.yaml', 'tests', 'output', '数据', '.pytest_cache']) assert.equal(fs.existsSync(path.join(invoice, name)), false, name);
});
