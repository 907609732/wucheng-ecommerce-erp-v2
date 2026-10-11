/**
 * 页面适配器纯逻辑测试：不需要浏览器、不需要真实平台。
 * 覆盖“分类发现 / 账期核对 / 店铺核对 / 唯一性停止 / 限制与空态区分 / 分片计划 / 完整性”。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLabel, completeness, extractLimits, extractRecordCount, looksLikeEmpty, looksLikeError, looksLikeLogin, planShards } from '../desktop/shared/finance-bills.mjs';
import { SNAPSHOT_SCRIPT, actionScript, detectState, discoverCategories, discoverSubtypes, findMonthControls, parseExportRows, planStep, verifyShopIdentity } from '../desktop/shared/finance-page.mjs';
import { overallState } from '../desktop/shared/finance-rpa.mjs';

const entry = over => ({ i: 0, tag: 'button', role: '', type: '', text: '', aria: '', title: '', placeholder: '', name: '', id: '', cls: '', href: '', disabled: false, checked: false, value: '', selector: 'body > button', x: 10, y: 20, w: 80, h: 24, ...over });
const snapshot = (entries, text = '') => ({ url: 'https://qn.taobao.com/home.htm', title: '千牛', text, entries, tables: [], truncated: false });
const ACCOUNT = 'test-shop-001';

const categoryTabs = () => [
  entry({ tag: 'button', role: 'tab', cls: 'bill-tab', text: '收入账单', id: 'tab-income', selector: 'html > body > div.bill-tabs > button.bill-tab' }),
  entry({ tag: 'button', role: 'tab', cls: 'bill-tab', text: '支出账单', id: 'tab-expense', selector: 'html > body > div.bill-tabs > button.bill-tab-2' }),
  entry({ tag: 'button', role: 'tab', cls: 'bill-tab', text: '涉税信息报送账单', id: 'tab-tax', selector: 'html > body > div.bill-tabs > button.bill-tab-3' })
];
const subtypeTabs = () => [
  entry({ tag: 'button', cls: 'segment-item', text: '全部', id: 'sub-all', selector: 'html > body > div.segment > button.segment-item' }),
  entry({ tag: 'button', cls: 'segment-item', text: '商品收入', id: 'sub-goods', selector: 'html > body > div.segment > button.segment-item-2' })
];
const monthInput = value => entry({ tag: 'input', type: 'month', value, id: 'billMonth', selector: '#billMonth' });
const exportButton = (id = 'export') => entry({ tag: 'button', text: '导出', id, selector: `#${id}` });
const queryButton = () => entry({ tag: 'button', text: '查询', id: 'query', selector: '#query' });
const page = (extra = [], text = '店铺账号 test-shop-001 收支账单') => snapshot([...categoryTabs(), ...subtypeTabs(), monthInput('2026-09'), queryButton(), ...extra], text);

test('分类名称映射到账本口径，含糊或未知名称不猜测', () => {
  assert.equal(classifyLabel('收入账单').kind, 'income');
  assert.equal(classifyLabel('支出账单').kind, 'expense');
  assert.equal(classifyLabel('涉税信息报送账单').kind, 'tax');
  assert.equal(classifyLabel('技术服务费').kind, 'expense');
  assert.equal(classifyLabel('资金流水').kind, null);
  assert.equal(classifyLabel('收支总览').ambiguous, false);
  assert.equal(classifyLabel('收入支出汇总').ambiguous, true);
  assert.equal(classifyLabel('收入支出汇总').kind, null);
});

test('页面自述的限制与条数只转述不推导', () => {
  const limits = extractLimits('单次最多导出50,000条，超过请分次导出；查询时间范围最多31天');
  assert.deepEqual(limits.filter(item => item.key === 'rows').map(item => item.value), [50000]);
  assert.deepEqual(limits.filter(item => item.key === 'days').map(item => item.value), [31]);
  assert.equal(extractRecordCount('共 12,345 条记录'), 12345);
  assert.equal(extractRecordCount('没有条数信息'), null);
});

test('登录、验证码、查询失败、无账单四类文案互不混淆', () => {
  assert.ok(looksLikeLogin('请扫码登录后继续'));
  assert.ok(looksLikeEmpty('当前查询条件下数据为空'));
  assert.ok(looksLikeError('系统繁忙，请稍后重试'));
  assert.equal(looksLikeEmpty('系统繁忙，请稍后重试'), false);
  assert.equal(detectState(snapshot([], '请扫码登录')).state, 'needs_login');
  assert.equal(detectState(snapshot([], '请拖动滑块完成验证')).state, 'needs_captcha');
  assert.equal(detectState(snapshot([], '系统繁忙，请稍后重试')).state, 'query_failed');
  assert.equal(detectState(snapshot([], '当前查询条件下数据为空')).state, 'empty');
  assert.equal(detectState(page()).state, 'ok');
});

test('分类与子类型分组发现：账单类型取覆盖口径最多的那一组', () => {
  const categories = discoverCategories(page());
  assert.deepEqual(categories.discovered.map(item => item.kind).sort(), ['expense', 'income', 'tax']);
  assert.deepEqual(categories.missing, []);
  const subtypes = discoverSubtypes(page(), categories.discovered.map(item => item.label));
  assert.deepEqual(subtypes.map(item => item.label), ['全部', '商品收入']);
  const excluded = discoverSubtypes(page(), categories.discovered.map(item => item.label), ['全部']);
  assert.deepEqual(excluded.map(item => item.label), ['商品收入']);
});

test('店铺核对：账号未出现或未设置都停止', () => {
  assert.equal(verifyShopIdentity(page(), ACCOUNT).matched, true);
  assert.equal(verifyShopIdentity(page(), 'other-shop').matched, false);
  assert.equal(verifyShopIdentity(page(), '').matched, null);
});

test('月份控件按类型与值识别，不做坐标猜测', () => {
  const controls = findMonthControls(page());
  assert.equal(controls.length, 1);
  assert.equal(controls[0].value, '2026-09');
});

test('决策：登录墙/未设置账号/页面异常都停止自动化', () => {
  const base = { month: '2026-09', account: ACCOUNT, kind: 'income' };
  assert.equal(planStep(snapshot([], '请扫码登录'), base).state, 'needs_login');
  assert.equal(planStep(snapshot([], '系统繁忙，请稍后重试'), base).state, 'query_failed');
  assert.equal(planStep(page(), { ...base, account: '' }).state, 'needs_shop_review');
  assert.equal(planStep(page([], '店铺账号 someone-else'), base).state, 'needs_shop_review');
});

test('决策：账期不一致先改账期，且给出可复验的动作', () => {
  const plan = planStep(snapshot([...categoryTabs(), monthInput('2026-08'), queryButton(), exportButton()], '店铺账号 test-shop-001'), { month: '2026-09', account: ACCOUNT, kind: 'income' });
  assert.equal(plan.state, 'set_month');
  assert.equal(plan.action.op, 'setMonth');
  // 账期控件可能是起止两个输入框，动作改为携带 targets 列表。
  assert.deepEqual(plan.action.targets.map(t => t.value), ['2026-09']);
  assert.equal(plan.action.targets[0].selector, '#billMonth');
});

test('决策：依次切换账单类型与子类型，全部完成才请求导出', () => {
  const base = { month: '2026-09', account: ACCOUNT, kind: 'income' };
  assert.equal(planStep(page([exportButton()]), base).state, 'pick_category');
  assert.equal(planStep(page([exportButton()]), { ...base, selectedCategory: '收入账单' }).state, 'pick_subtype');
  assert.equal(planStep(page([exportButton()]), { ...base, selectedCategory: '收入账单', selectedSubtype: '全部', doneSubtypes: ['全部'] }).action.expect.text, '商品收入');
  const ready = planStep(page([exportButton()]), { ...base, selectedCategory: '收入账单', selectedSubtype: '商品收入', doneSubtypes: ['全部', '商品收入'], queryRequested: true });
  assert.equal(ready.state, 'request_export');
  assert.equal(ready.action.expect.text, '导出');
});

test('决策：导出入口不唯一时停止，不随手挑一个', () => {
  const plan = planStep(snapshot([...categoryTabs(), ...subtypeTabs(), monthInput('2026-09'), exportButton('export-a'), exportButton('export-b')], '店铺账号 test-shop-001'), { month: '2026-09', account: ACCOUNT, kind: 'income', selectedCategory: '收入账单', selectedSubtype: '全部', doneSubtypes: ['全部', '商品收入'], queryRequested: true });
  assert.equal(plan.state, 'needs_manual');
  assert.match(plan.message, /多个疑似导出入口/);
});

test('决策：账单类型在页面上找不到时明确未接通', () => {
  const plan = planStep(snapshot([...categoryTabs().slice(0, 2), monthInput('2026-09')], '店铺账号 test-shop-001'), { month: '2026-09', account: ACCOUNT, kind: 'tax', selectedCategory: '收入账单', queryRequested: true });
  assert.equal(plan.state, 'needs_manual');
  assert.match(plan.message, /涉税信息报送账单|tax/);
});

test('决策：已请求导出但页面仍未变化时转人工，不视为成功', () => {
  const plan = planStep(page([exportButton()]), { month: '2026-09', account: ACCOUNT, kind: 'income', selectedCategory: '收入账单', selectedSubtype: '全部', doneSubtypes: ['全部', '商品收入'], requestedExport: true, queryRequested: true });
  assert.equal(plan.state, 'awaiting_export');
});

test('分片计划：超限且没有可用维度时要求人工拆分', () => {
  const manual = planShards({ recordCount: 180000, limits: [{ key: 'rows', value: 50000 }], dimensions: [] });
  assert.equal(manual.needsManual, true);
  assert.equal(manual.shards.length, 0);
  const planned = planShards({ recordCount: 120000, limits: [{ key: 'rows', value: 50000 }], dimensions: [{ key: 'dateRange' }] });
  assert.equal(planned.shards.length, 3);
  assert.equal(planShards({ recordCount: 100, limits: [{ key: 'rows', value: 50000 }], dimensions: [] }).needsManual, false);
});

test('完整性：一个子类型没到就不算整类完成', () => {
  assert.equal(completeness({ kind: '收入账单', discoveredSubtypes: ['全部', '商品收入'], receivedSubtypes: ['全部'] }).complete, false);
  assert.deepEqual(completeness({ kind: '收入账单', discoveredSubtypes: ['全部', '商品收入'], receivedSubtypes: ['全部'] }).missing, ['商品收入']);
  assert.equal(completeness({ kind: '收入账单', discoveredSubtypes: ['全部', '商品收入'], receivedSubtypes: ['商品收入', '全部'] }).complete, true);
  // 没有子类型时，账单类型自身就是唯一单元；一个文件都没收到就不算完成。
  assert.equal(completeness({ kind: '收入账单', discoveredSubtypes: [], receivedSubtypes: [] }).complete, false);
  assert.equal(completeness({ kind: '收入账单', discoveredSubtypes: [], receivedSubtypes: ['收入账单'] }).complete, true);
});

test('导出中心：按账期匹配到可下载行', () => {
  const rows = parseExportRows(snapshot([
    entry({ tag: 'span', text: '2026-09 收入账单 已完成', y: 100, h: 30 }),
    entry({ tag: 'a', text: '下载', href: '/download/1', y: 100, h: 30, id: 'dl-1', selector: '#dl-1' }),
    entry({ tag: 'span', text: '2026-08 收入账单 已完成', y: 140, h: 30 }),
    entry({ tag: 'a', text: '下载', href: '/download/2', y: 140, h: 30, id: 'dl-2', selector: '#dl-2' })
  ]));
  assert.equal(rows.length, 2);
  const target = rows.find(row => row.months === '2026-09');
  assert.equal(target.download.id, 'dl-1');
});

test('动作脚本按语义唯一命中，不携带坐标', () => {
  const script = actionScript({ op: 'click', selector: '#export', expect: { text: '导出', id: 'export' } });
  assert.match(script, /querySelectorAll/);
  assert.match(script, /hits.length !== 1/);
  assert.equal(/"x":/.test(script), false);
  assert.match(SNAPSHOT_SCRIPT, /getBoundingClientRect/);
});

test('总体状态汇总：人工与失败优先于部分完成', () => {
  assert.equal(overallState([{ state: 'received' }, { state: 'received' }]), 'received');
  assert.equal(overallState([{ state: 'received' }, { state: 'needs_manual' }]), 'needs_review');
  assert.equal(overallState([{ state: 'received' }, { state: 'failed' }]), 'failed');
});

// ---------------------------------------------------------------------------
// 以下用例按 2026-10-10 真机采集到的页面结构补写（见 tests/finance-real-probe.mjs 的输出）。
// 真机上出现的：两个导出按钮（导出PDF / 导出Excel）、左侧整列业务导航、
// 起止两个输入框的月份区间、公告弹窗与消息浮层、以及「限制：50000 条」。
// ---------------------------------------------------------------------------
const { findDismissEntries, findExportEntry, findMonthGroups, monthValuesFor } = await import('../desktop/shared/finance-page.mjs');
const { extractShardHints, dayRanges } = await import('../desktop/shared/finance-bills.mjs');

/** 真机同一横向区域内的账单视图 tab。 */
const realSubtypeTabs = () => [
  entry({ tag: 'button', cls: 'wui-tabs-tab segment-item', text: '月汇总', selector: 'html > body > div.panel > div.wui-tabs > button.t-1', x: 320, y: 430 }),
  entry({ tag: 'button', cls: 'wui-tabs-tab segment-item', text: '日汇总', selector: 'html > body > div.panel > div.wui-tabs > button.t-2', x: 392, y: 430 }),
  entry({ tag: 'button', cls: 'wui-tabs-tab segment-item', text: '收入明细', selector: 'html > body > div.panel > div.wui-tabs > button.t-3', x: 464, y: 430 })
];

/** 真机左侧那一整列业务导航（财务 → 对账管理 / 发票管理 …）。 */
const realLeftNav = () => [
  entry({ tag: 'a', href: '/home.htm/finance/assets', cls: 'menu-item', text: '保证金', selector: 'html > body > div.menu > a.menu-assets', x: 120, y: 600 }),
  entry({ tag: 'a', href: '/home.htm/finance/invoice/apply', cls: 'menu-item', text: '申请发票', selector: 'html > body > div.menu > a.menu-invoice', x: 120, y: 520 }),
  entry({ tag: 'a', href: '/home.htm/finance/reconcile', cls: 'menu-item', text: '对账管理', selector: 'html > body > div.menu > a.menu-reconcile', x: 120, y: 300 }),
  entry({ tag: 'a', href: '/home.htm/finance/fund', cls: 'menu-item', text: '资金管理', selector: 'html > body > div.menu > a.menu-fund', x: 120, y: 250 })
];

test('导出：同时存在 导出PDF 与 导出Excel 时只锁定 Excel', () => {
  const view = snapshot([
    entry({ tag: 'button', text: '导出PDF', selector: '#exportPdf', id: 'exportPdf', cls: 'wui-btn' }),
    entry({ tag: 'button', text: '导出Excel', selector: '#exportExcel', id: 'exportExcel', cls: 'wui-btn' })
  ]);
  const found = findExportEntry(view);
  assert.equal(found.ok, true);
  assert.equal(found.format, 'excel');
  assert.equal(found.entry.text, '导出Excel');
});

test('导出：没有 Excel 按钮时不会被 PDF 冒充', () => {
  const view = snapshot([
    entry({ tag: 'button', text: '导出PDF', selector: '#exportPdf', id: 'exportPdf' })
  ]);
  const found = findExportEntry(view);
  assert.equal(found.ok, false);
});

test('子类型：左侧业务导航不会被当成账单子类型', () => {
  const view = snapshot([...categoryTabs(), ...realSubtypeTabs(), ...realLeftNav()]);
  const categories = discoverCategories(view);
  assert.deepEqual(categories.discovered.map(item => item.kind).sort(), ['expense', 'income', 'tax']);
  const subtypes = discoverSubtypes(view, categories.discovered.map(item => item.label),
    [], { categoryGroup: categories.categoryGroup, categoryMinX: categories.categoryMinX });
  assert.deepEqual(subtypes.map(item => item.label), ['月汇总', '日汇总', '收入明细']);
});

test('账期：起止两个输入框会一起写入', () => {
  const range = [
    entry({ tag: 'input', type: 'text', value: '2026-08', selector: 'html > body > div.picker > span > input', cls: 'wn-input', x: 300 }),
    entry({ tag: 'input', type: 'text', value: '2026-08', selector: 'html > body > div.picker > span > input', cls: 'wn-input', x: 420 })
  ];
  const view = () => snapshot([...categoryTabs(), ...range], '店铺账号 acct-A 收支账单');
  const groups = findMonthGroups(view());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].range, true);
  const plan = planStep(view(), { month: '2026-09', account: 'acct-A' });
  assert.equal(plan.state, 'set_month');
  // 两个输入框共用同一选择器且是月粒度时，一次写入即可，不能把起止互相覆盖。
  assert.deepEqual(plan.action.targets.map(t => t.value), ['2026-09']);
  assert.equal(plan.evidence.format, 'month');
});

test('账期：页面用完整日期时自动补齐当月首末日', () => {
  assert.deepEqual(monthValuesFor('2026-09', '2026-08-01'), { start: '2026-09-01', end: '2026-09-30', format: 'date' });
  assert.deepEqual(monthValuesFor('2026-02', '2026-01-01'), { start: '2026-02-01', end: '2026-02-28', format: 'date' });
  assert.deepEqual(monthValuesFor('2026-09', '2026-08'), { start: '2026-09', end: '2026-09', format: 'month' });
});

test('遮挡层：只关闭明确无害的提示按钮', () => {
  const base = {
    ...snapshot([...categoryTabs()]),
    overlays: [{
      text: '收支账单更新了～ 拆分为：收入账单（积分类服务费）、支出账单两个页面',
      selector: 'div.notice-layer',
      closers: [
        { label: '关闭', selector: 'div.notice-layer > button.close', cls: 'close' },
        { label: '查看更多', selector: 'div.notice-layer > a.more', cls: 'more' },
        { label: '立即开通', selector: 'div.notice-layer > button.buy', cls: 'buy' }
      ]
    }]
  };
  const dismiss = findDismissEntries(base);
  assert.deepEqual(dismiss.map(item => item.label), ['关闭']);
  const plan = planStep({ ...base, text: `${base.text} 店铺账号 acct-A` }, { month: '2026-09', account: 'acct-A' });
  assert.equal(plan.state, 'dismiss_popup');
});

test('遮挡层：已经关过的提示不会反复关闭', () => {
  const base = {
    ...snapshot([]),
    overlays: [{ text: '重要消息 预警通知', selector: 'div.msg-layer', closers: [{ label: '关闭', selector: 'div.msg-layer > i.close', cls: 'close' }] }]
  };
  assert.equal(findDismissEntries(base).length, 1);
  assert.equal(findDismissEntries(base, ['关闭']).length, 0);
});

test('超限：认出平台自述的“缩小查询时间范围”拆分维度并给出连续分片清单', () => {
  const hints = extractShardHints('…建议缩小查询时间范围后，再进行导出');
  assert.deepEqual(hints.map(item => item.key), ['time-range']);
  const shard = planShards({ recordCount: 120000, limits: [{ key: 'rows', value: 50000, raw: '限制：50000 条' }], dimensions: [], hints, month: '2026-09' });
  assert.equal(shard.dimension, 'time-range');
  assert.equal(shard.needsManual, true);
  assert.equal(shard.shards.length, 30);
  assert.deepEqual(shard.shards[0], { index: 1, total: 30, from: '2026-09-01', to: '2026-09-01' });
  assert.deepEqual(shard.shards[29], { index: 30, total: 30, from: '2026-09-30', to: '2026-09-30' });
  assert.equal(dayRanges('2026-02').length, 28);
});

test('导出记录：解析结果必须带行号，供动作绑定到具体导出任务', () => {
  const view = snapshot([
    entry({ tag: 'td', text: '2026-09', selector: 'body > table > tbody > tr > td', row: 1, x: 40, y: 120, h: 30 }),
    entry({ tag: 'td', text: '涉税信息报送账单 月汇总 已完成', selector: 'body > table > tbody > tr > td', row: 1, x: 220, y: 120, h: 30 }),
    entry({ tag: 'a', text: '下载', selector: 'body > table > tbody > tr > td > a', row: 1, x: 700, y: 120, h: 30 })
  ]);
  const rows = parseExportRows(view);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].months, '2026-09');
  // 多条导出记录的选择器完全相同时，只能靠行号区分；没有行号就会判为歧义而停下。
  assert.equal(rows[0].download.row, 1);
  assert.equal(rows[0].download.text, '下载');
});

test('动作：指定行号时只在那一行内解析，并可校验行内容是否已变化', () => {
  const script = actionScript({ op: 'click', row: 3, selector: 'td > a', expect: { text: '下载' }, rowText: '2026-09' });
  assert.match(script, /"row":3/, '动作里必须带上行号');
  assert.match(script, /querySelectorAll\('tr'\)\[/, '解析范围必须按行号收敛');
  assert.match(script, /row_changed/, '行内容变化时必须停止而不是照点');
});
