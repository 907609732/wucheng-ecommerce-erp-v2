import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {buildTaobaoSupplement} from '../lib/taobao-supplement.mjs';
import {openStore,summarize} from '../lib/store.mjs';
import {createApp} from '../server.mjs';

const headers=['订单ID','用户名','下单日期','商家名','订单状态','本单实付总款','商品名','规格','价格','数量','收货地址','收货人电话','付款时间','物流公司','运单号','子订单ID','支付宝交易号'];
const table=()=>({sheet:'订单明细',headers,rows:[{row:2,cells:['T-001','buyer-test','2026-01-31 23:59:00','测试店','交易成功','11','商品甲','商品规格 : 白色','3','2','收件测试 ，138****0000 ， ，测试地址 ，000000','138****0000','2026-02-01 00:01:00','测试物流','00000012345678901234','CHILD-1','PAY-TEST']},{row:3,cells:['T-001','buyer-test','2026-01-31 23:59:00','测试店','交易成功','','商品乙','颜色分类 : 蓝色','5','1','收件测试 ，138****0000 ， ，测试地址 ，000000','138****0000','2026-02-01 00:01:00','测试物流','00000012345678901234','CHILD-2','PAY-TEST']}]});
const order=()=>({platform:'淘宝',account:'待补充',orderNo:'T-001',date:'2026-01-31',paidAt:'',supplier:'测试店',status:'已完成',amountCents:1100,refundCents:0,shippingCents:0,note:'保留手工备注',items:[{title:'商品甲',spec:'白色',qty:2,unit:'个',unitPriceCents:300},{title:'商品乙',spec:'蓝色',qty:1,unit:'件',unitPriceCents:500}]});
const metadata=plan=>({filename:'补充.xlsx',hash:'test-source-hash',filePath:'originals/test.xlsx',lineCount:3,summary:plan.summary});

test('按订单账号和商品匹配，只补空缺；合并行金额只读一次，收货地址明确拆分',()=>{
 const old={...order(),id:'old',updatedAt:'2026-01-01',phone:'手工联系电话'};
 const plan=buildTaobaoSupplement(table(),[old,{...old,id:'unmatched',orderNo:'T-002'}]);
 assert.equal(plan.summary.matched,1);assert.equal(plan.entries[0].patch.recipient,'收件测试');
 assert.equal(plan.entries[0].patch.address,'测试地址');assert.equal(plan.entries[0].patch.trackingNo,'00000012345678901234');
 assert.equal(plan.entries[0].patch.paidAt,'2026-02-01');assert.equal(plan.entries[0].patch.phone,undefined);
 assert.deepEqual(plan.entries[0].conflicts,['phone']);assert.equal(plan.entries[0].patch.amountCents,undefined);
 const other={...old,id:'other',account:'另一采购号'};
 assert.equal(buildTaobaoSupplement(table(),[old,other]).summary.matched,0);
 assert.equal(buildTaobaoSupplement(table(),[{...old,amountCents:1200}]).summary.matched,0);
 const missing=table();missing.rows[0].cells[0]='T-MISSING';assert.equal(buildTaobaoSupplement(missing,[old]).summary.matched,0);
});

test('补充保留首次原始数据、商品、备注、ID与未覆盖订单，重复执行幂等，详情接口可回查原字段',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-supplement-'));
 const {app,store}=createApp({dataDir:dir});let server;
 try{
  const old=store.insert(order(),null,{firstImport:'不可改写'});
  store.insert({...order(),platform:'1688',orderNo:'OTHER'},null,{other:'原件'});
  const before=store.db.prepare('SELECT * FROM orders ORDER BY id').all();
  const plan=buildTaobaoSupplement(table(),store.list());const result=store.supplementBatch(plan.entries,metadata(plan));
  assert.equal(result.updated,1);assert.equal(store.list().length,2);
  const saved=store.get(old.id);assert.equal(saved.note,old.note);assert.deepEqual(saved.items,old.items);assert.equal(saved.sourceId,old.sourceId);assert.equal(saved.createdAt,old.createdAt);
  assert.equal(saved.amountCents,1100);assert.equal(saved.paidAt,'2026-02-01');assert.equal(saved.account,'buyer-test');
  assert.equal(store.find(order()).id,old.id,'旧的待补充账号导出仍关联原订单，避免二次入账');
  assert.equal(store.find({...order(),account:'另一实际账号'}),null,'已知的不同账号不自动合并');
  const after=store.db.prepare('SELECT * FROM orders ORDER BY id').all();
  for(const b of before){const a=after.find(r=>r.id===b.id);assert.equal(a.original,b.original);if(b.platform!=='淘宝')assert.deepEqual(a,b);}
  const s=summarize(store.list(),'2026');assert.equal(s.months[1].amountCents,1100);
  assert.equal(store.supplementBatch(plan.entries,metadata(plan)).alreadyApplied,true);
  assert.equal(store.supplements(old.id).length,1);assert.equal(store.history(old.id).length,2);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const sources=await fetch(`http://127.0.0.1:${server.address().port}/api/orders/${old.id}/supplements`).then(r=>r.json());
  assert.deepEqual(sources[0].original.rows,table().rows);assert.equal(sources[0].filename,'补充.xlsx');
 }finally{if(server)await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('过期补充计划和覆盖已有值均回滚，不遗留半批数据或导入记录',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-stale-'));const store=openStore(dir);
 try{
  const o=store.insert(order(),null,{}),plan=buildTaobaoSupplement(table(),store.list());
  store.update(o.id,{...o,note:'新备注'});
  assert.throws(()=>store.supplementBatch(plan.entries,metadata(plan)),/已被修改/);
  assert.equal(store.imports().length,0);assert.equal(store.supplements(o.id).length,0);
  const fresh=buildTaobaoSupplement(table(),store.list());fresh.entries[0].patch.note='不能覆盖';
  assert.throws(()=>store.supplementBatch(fresh.entries,metadata(fresh)),/无效/);
  assert.equal(store.get(o.id).note,'新备注');assert.equal(store.imports().length,0);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
