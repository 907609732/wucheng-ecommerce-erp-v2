import test from 'node:test';
import assert from 'node:assert/strict';
import { pddInvoicePageStatus, parsePddInvoiceCounts, pddInvoiceAllowedUrl } from '../desktop/shared/pdd-invoice.mjs';

// 页面可见口径：10 日内未开票数属于历史指标，当前列表的「全部待开票」才是巡检目标。
const page = `拼多多 商家后台 店口五金店 订单开票 开票首页 发票管理\n店铺开票数据（统计时间：2026-10-10）\n普通发票10日内未开票数 1\n开票列表\n快速筛选订单 全部待开票 0 逾期未开票 0 24小时内需开票 0\n待开票 开票成功 开票失败 暂不开票\n暂无相关订单 共有 0 条 每页 10 条`;

test('PDD accepts only the invoice center and blocks untrusted navigation', () => {
  assert.equal(pddInvoicePageStatus('https://mms.pinduoduo.com/invoice/center', page).ok, true);
  assert.equal(pddInvoicePageStatus('https://mms.pinduoduo.com/login', page).ok, false);
  assert.equal(pddInvoiceAllowedUrl('https://evil.example/?next=mms.pinduoduo.com'), false);
  assert.equal(pddInvoiceAllowedUrl('https://mms.pinduoduo.com/invoice/center'), true);
});

test('PDD reads current pending tab, not the stale ten-day statistic', () => {
  assert.deepEqual(parsePddInvoiceCounts(page), { ok: true, pending: 0, unrecorded: null, coverage: 'visible_range' });
});

test('PDD cannot report zero if pending chip and table disagree', () => {
  assert.equal(parsePddInvoiceCounts(page.replace('全部待开票 0', '全部待开票 2')).ok, false);
});

test('PDD login wall, blank page and ambiguous counts are unknown', () => {
  assert.equal(pddInvoicePageStatus('https://mms.pinduoduo.com/invoice/center', '请扫码登录').ok, false);
  assert.equal(parsePddInvoiceCounts('订单开票 开票列表 全部待开票 0').ok, false);
  assert.equal(parsePddInvoiceCounts('订单开票 开票列表 全部待开票 0 全部待开票 1 共有 0 条').ok, false);
});
