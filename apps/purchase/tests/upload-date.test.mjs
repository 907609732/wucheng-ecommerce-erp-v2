import test from 'node:test';
import assert from 'node:assert/strict';
import {sortOrders,orderUploadDate,filterOrders} from '../public/order-query.mjs';
test('上传日期独立于采购日期和修改时间，按真实入账时间升降序并支持查询',()=>{
 const old={id:'old',date:'2026-10-18',paidAt:'',createdAt:'2026-01-01T16:00:00.000Z',updatedAt:'2026-12-01T00:00:00Z',items:[]};
 const recent={id:'recent',date:'2025-01-01',paidAt:'',createdAt:'2026-10-18T09:00:01.000Z',updatedAt:'2026-10-18T09:00:01Z',items:[]};
 assert.deepEqual(sortOrders([old,recent],[{field:'createdAt',dir:'desc'}]).map(o=>o.id),['recent','old']);
 assert.deepEqual(sortOrders([recent,old],[{field:'createdAt',dir:'asc'}]).map(o=>o.id),['old','recent']);
 assert.equal(orderUploadDate(recent.createdAt),'2026-10-18 17:00:01');assert.equal(orderUploadDate(''),'');
 assert.deepEqual(filterOrders([old,recent],{searchField:'uploadedAt',q:'2026-10-18'}).map(o=>o.id),['recent']);
});

test('物流固定选项筛选兼容历史公司名，其他包含非列表公司',()=>{
 const order=logisticsCompany=>({platform:'微信',items:[{title:'商品',shipments:[{trackingNo:'123',logisticsCompany}]}]});
 const sf=order('顺丰速运'),jd=order('京东物流'),other=order('德邦快递');
 assert.deepEqual(filterOrders([sf,jd,other],{carrier:'顺丰快递'}),[sf]);assert.deepEqual(filterOrders([sf,jd,other],{carrier:'其他'}),[other]);
});
