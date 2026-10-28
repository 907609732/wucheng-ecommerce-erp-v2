import test from 'node:test';
import assert from 'node:assert/strict';
import {supplierChoices,wireSupplierPicker} from '../public/supplier-picker.js';

test('选择供应商自动带入档案联系人电话和地址，切换地址及供应商不串资料',async()=>{
 const profiles=[{name:'供应商甲',contact:'张先生',phone:'13800138000',shops:[{platform:'微信',name:'供应商甲'}],addresses:[{label:'仓库',address:'仓库地址'},{name:'李先生',phone:'13900139000',address:'工厂地址'}]},{name:'供应商乙',shops:[{platform:'微信',name:'供应商乙'}],addresses:[]}];
 const before=JSON.stringify(profiles),elements=new Map();
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{value:'',dataset:{},addEventListener(){}});return elements.get(selector);};
 element('[name="platform"]').value='微信';element('[name="supplierContact-name"]').value='订单原联系人';
 await wireSupplierPicker({isConnected:true,querySelector:element},{orders:[],api:async route=>route==='/api/addresses'?[]:profiles,esc:s=>s});
 assert.equal(element('[name="supplierContact-name"]').value,'订单原联系人','初始化不覆盖已有订单快照');
 const select=element('#order-supplier-choice'),values=()=>['name','phone','address'].map(k=>element(`[name="supplierContact-${k}"]`).value);
 select.value=JSON.stringify(['微信','供应商甲']);select.onchange();assert.deepEqual(values(),['张先生','13800138000','仓库地址']);
 const addresses=element('[data-supplier-address-choice]');addresses.value='1';addresses.onchange();assert.deepEqual(values(),['李先生','13900139000','工厂地址']);
 select.value=JSON.stringify(['微信','供应商乙']);select.onchange();assert.deepEqual(values(),['','','']);
 assert.equal(JSON.stringify(profiles),before);
});

test('只有档案联系人和电话时也带入，不将收货信息当作供应商地址',()=>{
 const [row]=supplierChoices([{platform:'微信',supplier:'甲',recipient:'客户',phone:'客户电话',address:'客户地址'}],[],[{name:'甲',contact:'供应商联系人',phone:'供应商电话',shops:[{platform:'微信',name:'甲'}],addresses:[]}]);
 assert.deepEqual(row.contact,{name:'供应商联系人',phone:'供应商电话',address:''});
});

test('同档案同平台的三个历史名称统一选择，保留历史订单原名',async()=>{
 const names=['华仔智能锁','华仔智能锁 小米锁芯供应商A 湖北武汉','华仔智能锁小米锁芯供应商A 湖北武汉'];
 const orders=names.map(supplier=>({platform:'微信',supplier,account:'历史账号'}));
 const profiles=[{name:names[0],shops:names.map(name=>({platform:'微信',name,account:'默认账号'})),addresses:[]}];
 const before=JSON.stringify(orders),rows=supplierChoices(orders,[],profiles);
 assert.equal(rows.length,1);assert.equal(rows[0].supplier,names[0]);assert.deepEqual(rows[0].aliases,names);assert.equal(JSON.stringify(orders),before);
 const elements=new Map(),element=selector=>{if(!elements.has(selector))elements.set(selector,{value:'',dataset:{},addEventListener(){}});return elements.get(selector);};
 const root={isConnected:true,querySelector:element};
 element('[name="platform"]').value='微信';element('[name="supplier"]').value=names[2];
 await wireSupplierPicker(root,{orders,api:async route=>route==='/api/addresses'?[]:profiles,esc:s=>s});
 const select=element('#order-supplier-choice');
 assert.equal(select.value,rows[0].key);assert.equal((select.innerHTML.match(/>华仔智能锁<\/option>/g)||[]).length,1);
 assert.equal(element('[name="supplier"]').value,names[2]);
 select.onchange();assert.equal(element('[name="supplier"]').value,names[0]);
});

test('不同平台保留独立选择，档案名称不同于店铺时仍写入可关联的原店名',()=>{
 const rows=supplierChoices([],[],[{name:'统一供应商',shops:[{platform:'淘宝',name:'淘宝店'},{platform:'微信',name:'微信店'}],addresses:[]}]);
 assert.equal(rows.length,2);assert.ok(rows.every(row=>row.label==='统一供应商'));
 assert.deepEqual(rows.map(row=>row.supplier).sort(),['微信店','淘宝店']);
});

test('供应商选择按平台区分，优先使用最近维护的地址及最近采购账号',()=>{
 const orders=[{platform:'微信',supplier:'同名供应商',account:'旧账号',date:'2026-01-01',supplierContact:{name:'旧联系人'}},{platform:'微信',supplier:'同名供应商',account:'新账号',date:'2026-06-01'},{platform:'淘宝',supplier:'同名供应商',account:'淘宝账号',date:'2026-06-01'}];
 const addresses=[{platform:'微信',supplier:'同名供应商',name:'联系人甲',phone:'13800138000',address:'新地址',updatedAt:'2026-07-01'},{platform:'微信',supplier:'同名供应商',name:'联系人乙',address:'旧地址',updatedAt:'2026-05-01'},{name:'收货人',tags:['收货地址'],address:'不应作为供应商'}];
 const rows=supplierChoices(orders,addresses);assert.equal(rows.length,2);
 assert.equal(rows[0].platform,'微信');assert.equal(rows[0].account,'新账号');assert.equal(rows[0].maintained,true);
 assert.deepEqual(rows[0].contact,{name:'联系人甲',phone:'13800138000',address:'新地址'});
 assert.equal(rows[1].platform,'淘宝');assert.equal(rows[1].contact,null);
 assert.equal(orders[0].supplierContact.name,'旧联系人');
});

test('尚无订单的供应商地址可选，缺少联系信息保持为空',()=>{
 const rows=supplierChoices([{platform:'微信',supplier:'历史商家',account:'采购账号',recipient:'客户姓名',phone:'客户手机',address:'客户收货地址'},{platform:'微信',supplier:''}], [{platform:'微信',supplier:'新商家',name:'维护联系人',tags:['供应商地址']}]);
 assert.equal(rows.length,2);assert.equal(rows[0].supplier,'新商家');assert.equal(rows[0].contact.name,'维护联系人');
 assert.equal(rows[1].contact,null);
});
