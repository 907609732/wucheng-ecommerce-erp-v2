import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMonthPickerPlan,
  clickCainiaoControl,
  findVisibleExportButton
} from '../core/sync-cainiao-inventory.js';

function fakeLocator({ visible = true, enabled = true, interceptTrial = false } = {}) {
  const calls = [];
  return {
    calls,
    async scrollIntoViewIfNeeded(options) { calls.push(['scroll', options]); },
    async click(options = {}) {
      calls.push(['click', options]);
      if (options.trial && interceptTrial) throw new Error('element intercepts pointer events');
    },
    async isVisible() { return visible; },
    async isEnabled() { return enabled; }
  };
}

test('菜鸟控件正常路径只滚动一次并执行一次真实点击', async () => {
  const locator = fakeLocator();
  const result = await clickCainiaoControl(locator, { label: '导出明细按钮', timeout: 1200 });
  assert.deepEqual(result, { forced: false });
  assert.equal(locator.calls.filter(([type]) => type === 'scroll').length, 1);
  assert.deepEqual(locator.calls.filter(([type]) => type === 'click').map(([, options]) => options), [
    { trial: true, timeout: 1200 },
    { timeout: 1200 }
  ]);
});

test('菜鸟浮层拦截时快速回退为一次强制点击', async () => {
  const locator = fakeLocator({ interceptTrial: true });
  const result = await clickCainiaoControl(locator, { label: '导出明细按钮', timeout: 1200 });
  assert.deepEqual(result, { forced: true });
  assert.equal(locator.calls.filter(([type]) => type === 'scroll').length, 1);
  assert.deepEqual(locator.calls.filter(([type]) => type === 'click').at(-1)[1], { force: true, timeout: 1200 });
});

test('导出按钮优先使用语义角色且允许按钮在视口外', async () => {
  const button = fakeLocator();
  const empty = { count: async () => 0, nth: () => null };
  const group = { count: async () => 1, nth: () => button };
  const page = {
    getByRole: () => group,
    locator: () => empty
  };
  assert.equal(await findVisibleExportButton(page), button);
});

test('月份选择器计划按年份翻页并使用中文月份标签', () => {
  assert.deepEqual(buildMonthPickerPlan('2026-08', '2024-09'), {
    direction: 'previous',
    steps: 2,
    targetYear: 2024,
    monthLabel: '9月'
  });
  assert.deepEqual(buildMonthPickerPlan('2024-09', '2026-01'), {
    direction: 'next',
    steps: 2,
    targetYear: 2026,
    monthLabel: '1月'
  });
});
