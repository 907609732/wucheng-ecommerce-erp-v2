import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {formatWarehouseInventoryAlert,warehouseScript} from '../desktop/workbench/warehouse-adapter.mjs';
import {calculateInventoryAvailability,inventoryAlertLabel} from '../core/erp/inventory-alert.js';

// Synthetic service responses use the existing calculator and API label shape.
// No original SKU, amount, account or live database is read by these tests.
function item(quantity,sales,index){
 const {stockAlert,sellableDays}=calculateInventoryAvailability({totalQuantity:quantity,monthlyOutbound:sales,near30DaysSales:sales});
 return JSON.parse(JSON.stringify({sku:'SYNTHETIC-'+index,name:'格式契约样例',barcode:'',quantity,lowStockThreshold:999,stockState:'low',sellableDays,stockAlert:{...stockAlert,label:inventoryAlertLabel(stockAlert.level)},sourceDate:'2026-01-01'}));
}

test('remote warehouse uses API alert labels unchanged across existing availability boundaries',()=>{
 const rows=[item(6,30,1),item(7,30,2),item(15,30,3),item(30,30,4),item(0,0,5)],before=structuredClone(rows);
 assert.deepEqual(rows.map(formatWarehouseInventoryAlert),['🔴 不够卖 1 周','🟠 不够卖 2 周','🟡 不够卖 1 月','🟢 正常','🟢 正常']);
 assert.deepEqual(rows,before,'presentation must not change quantities, alert days or thresholds');
 // stockState uses a different quantity threshold; the page must not replace
 // the service's sellable-days alert with a new calculation.
 assert.equal(rows[3].stockState,'low');assert.equal(formatWarehouseInventoryAlert(rows[3]),'🟢 正常');
 assert.equal(rows[4].stockAlert.days,null,'JSON serializes the service Infinity as null');
});

test('alert text supports readable legacy values and never stringifies an object or invents normal state',()=>{
 assert.equal(formatWarehouseInventoryAlert({alertLabel:'已提供的兼容标签',stockAlert:{label:'服务标签'}}),'已提供的兼容标签');
 assert.equal(formatWarehouseInventoryAlert({stockAlert:{text:'服务提供的补货说明'}}),'服务提供的补货说明');
 assert.equal(formatWarehouseInventoryAlert({stockAlert:'旧接口预警'}),'旧接口预警');
 assert.equal(formatWarehouseInventoryAlert({alert:{label:'旧接口结构化说明'}}),'旧接口结构化说明');
 for(const row of [undefined,{}, {stockAlert:{level:'unknown',days:0}},{stockAlert:{label:{nested:true},text:[]}}, {stockAlert:[]}])assert.equal(formatWarehouseInventoryAlert(row),'—');
});

test('the served warehouse script renders structured API alerts as safe text, including after filtering',async()=>{
 const rows=[item(6,30,1),item(30,30,2),{sku:'SYNTHETIC-3',name:'未提供说明',quantity:0,stockAlert:{level:'unknown'}}],before=structuredClone(rows),elements=new Map(),created=[],requests=[];
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.value='';this.id='';this.textContent='';this.classList={toggle(){},add(){},remove(){}};created.push(this);}
  addEventListener(){}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  remove(){this.removed=true;}
 }
 const document={createElement:tag=>new Element(tag),querySelectorAll:()=>[],getElementById(id){const existing=elements.get(id)||created.find(e=>e.id===id);if(existing)return existing;const el=new Element('div');el.id=id;elements.set(id,el);return el;}};
 const fetch=async(url,options={})=>{
  requests.push({url,method:options.method||'GET'});assert.equal(options.method||'GET','GET','rendering must not create a job or business write');
  const data=url==='/api/workbench/v1/session'?{csrfToken:'synthetic-ui-nonce'}:url.endsWith('/state')?{busy:false,permissions:{runTasks:false}}:url.endsWith('/inventory')?{available:true,items:rows}:url.endsWith('/task')?{running:false,logs:[]}:url.endsWith('/daily')?{businessDate:'2026-01-01',actor:{login:'synthetic@example.test',role:'viewer',local:false},sync:{complete:false},employees:[],team:{},channels:{},reminders:[]}:null;assert(data,'unexpected UI route '+url);
  return {ok:true,json:async()=>data};
 };
 await new vm.Script('(async()=>{'+warehouseScript+'})();').runInNewContext({document,window:{addEventListener(){}},fetch,setInterval:()=>0,URLSearchParams,Date,crypto:{randomUUID:()=> 'synthetic-id'}});
 await new Promise(resolve=>setImmediate(resolve));
 const rendered=()=>document.getElementById('inventory-rows').children.map(tr=>tr.children.map(td=>td.textContent));
 assert.deepEqual(Array.from(rendered(),r=>r[4]),['🔴 不够卖 1 周','🟢 正常','—']);assert(!JSON.stringify(rendered()).includes('[object Object]'));assert.deepEqual(rows,before);
 document.getElementById('filter').value='SYNTHETIC-2';document.getElementById('filter').oninput();assert.equal(rendered().length,1);assert.equal(rendered()[0][4],'🟢 正常');
 rows[1].stockAlert.label='<img src=x onerror=alert(1)>';document.getElementById('filter').oninput();assert.equal(rendered()[0][4],'<img src=x onerror=alert(1)>');assert.equal(created.filter(e=>e.tag==='img').length,0,'labels remain text, not HTML');assert.equal(requests.length,5);
});
