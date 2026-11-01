import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hostDependencyPaths} from '../scripts/engineering/warehouse-extension.mjs';
import {deferredWarehouseFile} from '../desktop/product/extension-layout.mjs';
import {OPTIONAL_MODULE_IDS,DEFAULT_MODULE_IDS} from '../desktop/product/modules.mjs';

test('host closure excludes warehouse browser, chart, spreadsheet and messaging libraries',()=>{
 const lock=JSON.parse(fs.readFileSync(new URL('../package-lock.json',import.meta.url)));
 const paths=hostDependencyPaths(lock);
 assert.ok(paths.includes('node_modules/@modelcontextprotocol/server'));
 assert.ok(paths.includes('node_modules/fastify'));
 assert.ok(paths.includes('node_modules/yauzl'));
 assert.deepEqual(paths.filter(key=>/playwright|echarts|gridjs|xlsx|dingtalk-stream|dotenv|electron-updater/.test(key)),[]);
 assert.deepEqual(OPTIONAL_MODULE_IDS,['warehouse']);assert.ok(!DEFAULT_MODULE_IDS.includes('warehouse'));
});
test('warehouse source is deferred while launcher, signature verifier and shared data binding stay in the base',()=>{
 for(const file of ['core/config.js','desktop/main.mjs','desktop/renderer/index.html','desktop/workbench/warehouse-agent.mjs','desktop/shared/inventory-store.mjs'])assert.equal(deferredWarehouseFile(file),true,file);
 for(const file of ['desktop/launcher/main.mjs','desktop/modules/package-format.mjs','desktop/shared/workbench-location.mjs','desktop/business-host/on-demand.mjs'])assert.equal(deferredWarehouseFile(file),false,file);
});
