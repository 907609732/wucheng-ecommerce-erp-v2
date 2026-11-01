import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const source=fs.readFileSync(new URL('../core/sync-cainiao-inventory.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function synchronizeInventory('),source.indexOf('export async function main()'));
async function run(ok){
  const events=[];
  const context={console:{log(){}},process:{env:{}},createHash,
    fs:{existsSync:()=>true,readFileSync:()=>Buffer.from('inventory fixture')},
    exportWithSingleAuthRecovery:async()=>'/fixture.xlsx',expectedInventoryDate:()=> '2026-10-29',
    downloadDir:'/downloads',findLatestPriorCainiaoFile:()=>'',
    validateCainiaoInventoryFile:()=>({ok,sourceDate:'2026-10-29',rowCount:10,totalQuantity:100,warnings:[],errors:ok?[]:['bad inventory']}),
    recordInventoryValidation:()=>events.push('validate'),
    getDb:()=>({prepare:sql=>sql.startsWith('SELECT')?{get:()=>({id:7})}:{run:()=>{events.push('prune');return {changes:0};}}}),
    importInventoryFile:()=>{events.push('import');return {rowCount:10};},
    getInventoryReport:()=>({skuCount:10,totalQuantity:100}),buildInventoryMarkdown:()=>({title:'report',text:'inventory',shouldNotify:true}),
    sendInventoryDingTalkMarkdown:async()=>{events.push('send');return {processQueryKey:'test-receipt'};},
    inventoryDeliveryAccepted:()=>true,
    daily:{updateRun:(_id,fields)=>events.push(fields)},
  };
  const task=vm.runInNewContext(body+'; synchronizeInventory(daily,"test-run")',context);
  return {task,events};
}
test('downloaded inventory reaches validation, import, pruning and delivery',async()=>{
  const {task,events}=await run(true);await task;
  assert.deepEqual(events.filter(x=>typeof x==='string'),['validate','import','prune','send']);
  assert.ok(events.some(x=>x.validationId===7&&x.validationStatus==='success'));
  assert.ok(events.some(x=>x.deliveryStatus==='accepted'));
});
test('invalid inventory stops before import and delivery',async()=>{
  const {task,events}=await run(false);await assert.rejects(task,/库存数据校验失败/);
  assert.deepEqual(events.filter(x=>typeof x==='string'),['validate']);
});
