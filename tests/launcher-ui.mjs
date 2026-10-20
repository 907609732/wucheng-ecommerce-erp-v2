import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingtu-launcher-ui-'));
const registry = path.join(root, 'registry.json');
fs.writeFileSync(registry, JSON.stringify(Object.fromEntries(['purchase','sales','overview','exporter'].map(id => [id, {
  managed: true, root: path.join(root, id), dataDir: path.join(root, 'data', id), exe: path.join(root, id, 'missing.exe')
}]))));
const env = {...process.env, LINGTU_REGISTRY_PATH: registry}; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({executablePath: path.resolve(process.env.LAUNCHER_TEST_EXE || 'node_modules/electron/dist/electron.exe'),
  args: [...(process.env.LAUNCHER_TEST_EXE ? [] : [path.resolve('desktop/launcher')]), '--user-data-dir=' + root], env});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('#cards button').first().waitFor();
  assert.equal(await page.locator('#cards article').count(), 3);
  assert.deepEqual(await page.locator('#cards h2').allTextContents(), ['云仓同步','采购台','销售台']);
  assert.deepEqual(await page.locator('#cards button').allTextContents(), ['下载使用','下载使用','下载使用']);
  await page.locator('#settings').click();
  await page.locator('#settingsPanel').waitFor({state:'visible'});
  assert.ok(await page.locator('#moduleList article').count()>=5);
  await page.locator('#help').click();
  await page.locator('#helpDialog').waitFor({state:'visible'});
  await page.locator('#closeHelp').click();
  await page.locator('#home').click();
  await page.locator('#homePanel').waitFor({state:'visible'});
  fs.mkdirSync('dist/module-verification', {recursive:true});
  await page.screenshot({path:'dist/module-verification/launcher-first-install.png'});
  assert.deepEqual(errors, []);
  assert.ok(!fs.existsSync(path.join(root, 'workspace', 'data', 'erp.sqlite')));
  console.log(JSON.stringify({ok:true, homeEntries:3, noBusinessDatabaseCreated:true, rendererErrors:errors}));
} finally { await app.close(); }
