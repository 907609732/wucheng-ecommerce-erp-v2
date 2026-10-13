import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvoiceShopStore, matchingInvoiceAccount, invoiceShopLedgerName } from '../desktop/shared/invoice-shops.mjs';

test('invoice shop configuration is independent, persists, and requires confirmed account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-shops-'));
  try {
    const shops = new InvoiceShopStore(dir);
    assert.deepEqual(shops.list(), []);
    const shop = shops.add('米配匠');
    assert.ok(shop.id);
    assert.ok(shop.createdAt);
    assert.equal(shop.account, '');
    assert.throws(() => shops.add(' 米配匠 '), /已存在/);
    assert.throws(() => shops.confirm(shop.id, ''), /登录账号/);
    shops.confirm(shop.id, 'seller_1');
    assert.equal(new InvoiceShopStore(dir).list()[0].account, 'seller_1');
    assert.equal(matchingInvoiceAccount(shops.get(shop.id), ['seller_2']).ok, false);
    assert.equal(matchingInvoiceAccount(shops.get(shop.id), ['seller_1']).ok, true);
    assert.equal(matchingInvoiceAccount(shops.get(shop.id), []).ok, false);
    shops.remove(shop.id);
    assert.deepEqual(new InvoiceShopStore(dir).list(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('header confirmation persists independently of nickname cookie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-header-'));
  try {
    const store = new InvoiceShopStore(dir);
    const shop = store.add('店口五金店');
    assert.throws(() => store.confirmHeader(shop.id, '其他店铺'), /不一致/);
    store.confirmHeader(shop.id, shop.name);
    assert.equal(new InvoiceShopStore(dir).get(shop.id).identityMode, 'header');
    assert.equal(matchingInvoiceAccount(store.get(shop.id), [], ['店口五金店']).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy Taobao shop and same-name PDD shop remain separate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-platforms-'));
  try {
    const store = new InvoiceShopStore(dir);
    const taobao = store.add('店口五金店');
    const pdd = store.add('店口五金店', 'pdd');
    assert.equal(store.get(taobao.id).platform || 'taobao', 'taobao');
    assert.equal(store.get(pdd.id).platform, 'pdd');
    assert.notEqual(invoiceShopLedgerName(taobao), invoiceShopLedgerName(pdd));
    assert.throws(() => store.add('店口五金店', 'pdd'), /已存在/);
    store.confirmHeader(pdd.id, '店口五金店');
    assert.equal(store.get(pdd.id).identityMode, 'header');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rename unconfirmed PDD registration preserves ID/session and requires exact header confirmation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-rename-'));
  try {
    const store = new InvoiceShopStore(dir);
    const taobao = store.add('店口五金店');
    const pdd = store.add('店口五金', 'pdd');
    assert.throws(() => store.confirmHeader(pdd.id, '店口五金店'), /不一致/);
    const renamed = store.rename(pdd.id, '店口五金店');
    assert.equal(renamed.id, pdd.id);
    assert.equal(renamed.name, '店口五金店');
    assert.equal(renamed.platform, 'pdd');
    assert.equal(store.get(taobao.id).name, '店口五金店');
    assert.equal(store.get(pdd.id).account, '');
    assert.equal(store.get(pdd.id).identityMode, undefined);
    store.confirmHeader(pdd.id, '店口五金店');
    assert.equal(matchingInvoiceAccount(store.get(pdd.id), [], ['店口五金店']).ok, true);
    assert.throws(() => store.rename(pdd.id, '别的店'), /已确认/);
    const other = store.add('其他淘宝店');
    assert.throws(() => store.rename(other.id, '店口五金店'), /已存在/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('header-confirmed shop checks the actual page header when nickname cookie is absent', () => {
  const shop = { name: '店口五金店', account: '', identityMode: 'header' };
  assert.equal(matchingInvoiceAccount(shop, [], ['店口五金店']).ok, true);
  assert.equal(matchingInvoiceAccount(shop, [], ['其他店铺']).ok, false);
  assert.equal(matchingInvoiceAccount(shop, [], []).ok, false);
});
