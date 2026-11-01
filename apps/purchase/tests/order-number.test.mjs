import test from 'node:test';
import assert from 'node:assert/strict';
import {newOrderNumber} from '../public/order-number.mjs';
test('微信新订单使用WX日期前缀，其他平台保留手工标识与唯一随机部分',()=>{const uuid='12345678-1234-4567-8123-123456789abc';assert.equal(newOrderNumber('微信','2026-10-18',uuid),'WX-20261018-12345678123445678123123456789abc');assert.match(newOrderNumber('手工','2026-10-18',uuid),/^MAN-20261018-/);assert.notEqual(newOrderNumber('微信','2026-10-18'),newOrderNumber('微信','2026-10-18'));});
