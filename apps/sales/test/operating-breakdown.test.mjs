import test from 'node:test';
import assert from 'node:assert/strict';
import {operatingBreakdown} from '../public/funds-overview.js';
const g=(category,income=0,expense=0)=>({category,count:1,income,expense});
test('提现和营销/保证金划转不减少经营结余，现金流水仍可对平',()=>{
 const rows=[g('0010002|订单收入',100000),g('0020002|退款',0,-10000),g('0030002|服务费',0,-1000),g('0030002|返还',200),g('0080001|提现',0,-50000),g('0070003|营销划转',0,-5000),g('0070001|保证金',0,-2000)];
 const b=operatingBreakdown(rows);
 assert.equal(b.surplus,89200);assert.equal(b.withdrawal,50000);assert.equal(b.transferOut,7000);assert.equal(b.cashNet,32200);
 assert.equal(b.cashNet,rows.reduce((s,r)=>s+r.income+r.expense,0));
 assert.equal(operatingBreakdown(rows.filter(r=>!r.category.startsWith('008'))).surplus,b.surplus);
});
test('退款优惠券、补贴、费用返还和未知业务不混淆',()=>{
 const rows=[g('tb_income|交易收入',10000),g('tb_refund|退款',0,-800),g('0010005|优惠券结算',500),g('0020005|优惠券退回',0,-100),g('0130005|申诉补回',50),g('0099999|未知',20,-30),g('0070003|营销账户退回',60)];
 const b=operatingBreakdown(rows);assert.equal(b.refund,900);assert.equal(b.surplus,9650);assert.equal(b.pendingIn,20);assert.equal(b.pendingOut,30);assert.equal(b.transferIn,60);
 assert.equal(b.cashNet,rows.reduce((s,r)=>s+r.income+r.expense,0));
});
test('空分类不会虚构利润或流水',()=>{const b=operatingBreakdown([]);assert.equal(b.surplus,0);assert.equal(b.cashNet,0);assert.equal(b.profit,undefined);});
