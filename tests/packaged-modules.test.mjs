import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listPackage, extractFile } from '@electron/asar';

test('Windows package contains only warehouse runtime and dependencies', () => {
  const resources = path.resolve('dist/win-unpacked/resources');
  const archive = path.join(resources, 'app.asar');
  const files = listPackage(archive).map(name => name.replaceAll('\\', '/'));
  assert.equal(files.some(name => /\/desktop\/(?:shared\/|renderer\/(?:vendor\/)?)?(?:business|finance|purchase|invoice|pdd)[-.]/.test(name)), false);
  assert.equal(files.some(name => name.includes('/@univerjs/') || name.includes('/fast-formula-parser/')), false);
  for (const name of ['core/erp/warehouse-monthly-sales.js','desktop/shared/inventory-store.mjs']) assert.ok(files.includes('/' + name), name);
  for(const dependency of ['exceljs','tabulator-tables','adm-zip']) assert.equal(files.some(name=>name.includes('/'+dependency+'/')),false,dependency);
  const packaged = JSON.parse(extractFile(archive, 'package.json').toString());
  assert.equal(packaged.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  const invoice = path.join(resources, 'invoice-module');
  assert.equal(fs.existsSync(invoice),false);
});
