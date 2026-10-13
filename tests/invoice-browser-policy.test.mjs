import test from 'node:test';
import assert from 'node:assert/strict';
import { invoicePartition, invoicePageStatus, invoiceAllowedUrl, invoiceTargetUrl } from '../desktop/shared/invoice-browser-policy.mjs';

test('invoice sessions never reuse finance partitions', () => {
  assert.match(invoicePartition('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), /^persist:invoice-/);
  assert.notEqual(invoicePartition('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'persist:finance-test-id');
});
test('PDD invoice session uses distinct partition and host policy', () => {
  const id = 'f8f17d3e-9b49-44b6-9f6f-15ff079b8783';
  assert.notEqual(invoicePartition(id), invoicePartition(id, 'pdd'));
  assert.equal(invoiceTargetUrl('pdd'), 'https://mms.pinduoduo.com/invoice/center');
  assert.equal(invoiceTargetUrl('taobao').includes('qn.taobao.com'), true);
  assert.equal(invoiceAllowedUrl('https://mms.pinduoduo.com/invoice/center', 'pdd'), true);
  assert.equal(invoiceAllowedUrl('https://qn.taobao.com/home.htm/merchant-invoice/', 'pdd'), false);
});

test('login and verification pages cannot count as empty invoice pages', () => {
  assert.equal(invoicePageStatus('https://login.taobao.com/member/login.jhtml', '登录').ok, false);
  assert.equal(invoicePageStatus('https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/agreed', '请完成滑块验证').ok, false);
  assert.equal(invoicePageStatus('https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/agreed', '只有空白页面').ok, false);
  assert.equal(invoicePageStatus('https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/agreed', '给买家开票 开票数据概览').ok, true);
});
