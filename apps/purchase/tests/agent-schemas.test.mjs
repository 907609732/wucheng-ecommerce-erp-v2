import test from 'node:test';import assert from 'node:assert/strict';
import {purchaseAgentCapabilities} from '../lib/agent-adapter.mjs';
import {validatePurchaseAgentInput as validate} from '../lib/agent-schemas.mjs';
test('每项采购能力均有封闭参数契约并拒绝授权材料、未知字段及错误金额日期',()=>{
 for(const c of purchaseAgentCapabilities){assert.ok(c.inputSchema,c.id);assert.equal(c.inputSchema.additionalProperties,false,c.id);assert.ok(c.inputSchema.properties,c.id);assert.match(c.description,/[\u4e00-\u9fff]/);}
 assert.throws(()=>validate('tasks',{month:'2026-13'}),/参数/);
 assert.throws(()=>validate('tasks',{month:'2026-10',actor:{role:'admin'}}),/参数/);
 assert.throws(()=>validate('image.cache',{id:'order'}),/参数/);
 assert.throws(()=>validate('orders.classification',{orders:[{id:'order',updatedAt:'v'}],category:'other'}),/参数/);
 assert.throws(()=>validate('order.create',{platform:'淘宝',orderNo:'123',date:'2026-10-01',supplier:'测试',amountCents:1.5,items:[{title:'商品',qty:1}]}),/参数/);
 validate('task.action',{month:'2026-10',taskId:'collect:淘宝',action:'start',revision:'revision'});
 validate('orders',{});validate('sources',{});
});
