import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { PurchaseAutomation, purchaseRange, validatePurchaseMeta, readPurchaseAccount, inspectPurchaseAccount } from '../desktop/shared/purchase-auto.mjs';
import { PurchaseCollector } from '../desktop/shared/purchase-collector.mjs';

test('日期范围校验支持跨月并拒绝无效日期', () => {
  assert.deepEqual(purchaseRange({ month: '2026-02' }), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(purchaseRange({ startDate: '2026-09-01', endDate: '2026-10-31' }), { start: '2026-09-01', end: '2026-10-31' });
  assert.throws(() => purchaseRange({ startDate: '2026-02-30', endDate: '2026-03-01' }));
  assert.throws(() => purchaseRange({ startDate: '2026-10-01', endDate: '2026-09-01' }));
  assert.equal(validatePurchaseMeta({ platform: 'alibaba_1688', month: '2026-09' }).account, '');
});

// mtop 接口返回的订单，金额单位为分。
const MTOP_ORDERS = [
  { id: 'A001', gmtCreate: '2026-09-10 10:00:00', statusLabel: '交易成功', sumPayment: '1300', carriage: '600', buyerInfo: { loginId: 'tb12345678' }, sellerInfo: { companyName: '深圳测试五金' }, orderEntries: [{ productName: '螺丝', specInfo: { specItems: [{ specValue: 'M3*10' }] }, actualUnitPrice: '7', quantity: { realAmount: 100 }, amount: '700' }] },
  { id: 'A002', gmtCreate: '2026-10-09 10:00:00', statusLabel: '交易成功', sumPayment: '3000', carriage: '0', buyerInfo: { loginId: 'tb12345678' }, sellerInfo: { companyName: '兴化不锈钢' }, orderEntries: [{ productName: '螺母', specInfo: {}, actualUnitPrice: '6', quantity: { realAmount: 500 }, amount: '3000' }] },
];

test('1688接口采集：mtop分页拉取、跨月归集、去重与空结果/未加载接口阻断', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-mtop-'));
  const store = new PurchaseCollector(path.join(directory, 'erp.sqlite'), path.join(directory, 'exports'));
  const states = [];
  const automation = new PurchaseAutomation({
    directory: path.join(directory, 'auto'),
    profiles: { alibaba_1688: { order_url: 'about:blank', need_login_url_contains: ['/login'] } },
    launch: (profile, options) => { assert.equal(options.channel, 'chrome'); return chromium.launchPersistentContext(profile, { ...options, headless: true }); },
    preview: (file, meta) => store.preview(file, { ...meta, automated: true }),
    commitPreview: token => store.commit(token),
    notify: state => states.push(state.state),
  });
  const meta = { platform: 'alibaba_1688', startDate: '2026-09-01', endDate: '2026-10-31' };
  try {
    const { page } = await automation.open(meta);
    await page.setContent(`<main>订单号</main><script>
      window.__ORDERS__ = ${JSON.stringify(MTOP_ORDERS)};
      window.lib = { mtop: function(params) { return { request: function() {
        const data = window.__ORDERS__;
        return Promise.resolve({ data: { data: { result: JSON.stringify({ data: { data, pages: 1, total: data.length, pageSize: 50 } }) } }, ret: ['SUCCESS::调用成功'] });
      } }; } };
    </script>`);

    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'completed', automation.state().message);
    assert.ok(automation.state().logs.every(entry => !entry.message.includes('tb12345678')));
    assert.ok(states.includes('running'));
    assert.equal(store.read().count, 2);
    assert.equal(store.read({ month: '2026-09' }).total, 13);
    assert.equal(store.read({ month: '2026-10' }).total, 30);

    // 重复采集 → 去重完成
    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'completed');
    assert.equal(store.read().count, 2);

    // 空结果 → needs_review
    await page.evaluate(() => { window.__ORDERS__ = []; });
    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'needs_review');
    assert.match(automation.state().message, /没有采购订单/);

    // 未加载平台接口 → failed
    await page.evaluate(() => { window.__ORDERS__ = []; delete window.lib; });
    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'failed');
    assert.match(automation.state().message, /未加载平台接口/);
  } finally { await automation.closeAll(); store.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('淘宝接口采集：mtop分页拉取、字段映射与自动入库', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-taobao-'));
  const store = new PurchaseCollector(path.join(directory, 'erp.sqlite'), path.join(directory, 'exports'));
  const states = [];
  const automation = new PurchaseAutomation({
    directory: path.join(directory, 'auto'),
    profiles: { taobao: { order_url: 'about:blank', need_login_url_contains: ['/login'] } },
    launch: (profile, options) => chromium.launchPersistentContext(profile, { ...options, headless: true }),
    preview: (file, meta) => store.preview(file, { ...meta, automated: true }),
    commitPreview: token => store.commit(token),
    notify: state => states.push(state.state),
  });
  const meta = { platform: 'taobao', startDate: '2026-09-01', endDate: '2026-10-31' };
  try {
    const { page } = await automation.open(meta);
    await page.setContent(`<main>订单</main><script>
      Object.defineProperty(document, 'cookie', { get: () => '_nk_=tb12345678', configurable: true });
      window.__TAOBAO__ = ${JSON.stringify({
        1: { hasMore: true, orders: [
          { orderId: '1001', createTime: '2026-09-10 10:00:00', shopName: '测试淘宝店', tradeTitle: '交易成功', actualFee: '￥13.00', discountFee: '￥0.00', postFee: '￥6.00', totalFee: '￥13.00', items: [{ itemId: '2001', title: '螺丝', skuText: 'M3*10', quantity: '100', unitPrice: '￥0.07', promotion: '￥0.07' }] },
        ]},
        2: { hasMore: false, orders: [
          { orderId: '1002', createTime: '2026-10-09 10:00:00', shopName: '测试淘宝店', tradeTitle: '交易成功', actualFee: '￥30.00', discountFee: '￥0.00', postFee: '￥0.00', totalFee: '￥30.00', items: [{ itemId: '2002', title: '螺母', skuText: 'M6', quantity: '500', unitPrice: '￥0.06', promotion: '￥0.06' }] },
        ]},
      })};
      window.lib = { mtop: { H5Request: function(params, success) {
        const p = params.data.page;
        const pageData = window.__TAOBAO__[p];
        const root = {};
        for (const order of pageData.orders) {
          root['shopOrderContainer_' + order.orderId] = {};
          root['shopInfo_' + order.orderId] = { fields: { orderId: order.orderId, createTime: order.createTime, shopName: order.shopName, tradeTitle: order.tradeTitle } };
          root['orderPayment_' + order.orderId] = { fields: { actualFee: { value: order.actualFee }, discountFee: { value: order.discountFee }, pcPostFee: { value: order.postFee }, totalFee: { value: order.totalFee } } };
          order.items.forEach(function(item) {
            root['orderItemInfo_' + order.orderId + '_' + item.itemId] = { fields: { item: { itemId: item.itemId, title: item.title, skuText: item.skuText, quantity: item.quantity, priceInfo: { actualTotalFee: item.unitPrice, promotion: item.promotion } } } };
          });
        }
        success({ ret: ['SUCCESS::调用成功'], data: { data: root, global: { pageControl: { hasMore: pageData.hasMore } } } });
      } } };
    </script>`);

    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'completed', automation.state().message);
    assert.ok(states.includes('running'));
    assert.equal(store.read().count, 2);
    assert.equal(store.read({ month: '2026-09' }).total, 13);
    assert.equal(store.read({ month: '2026-10' }).total, 30);
    const september = store.read({ month: '2026-09' }).rows[0];
    assert.equal(september.item, '螺丝 M3*10');
    assert.equal(september.quantity, 100);
    assert.equal(september.itemAmount, 7);
    assert.equal(september.freight, 6);
    assert.equal(september.accountLabel, 'tb12345678');

    // 未加载平台接口 → failed
    await page.evaluate(() => { delete window.lib; });
    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'failed');
  } finally { await automation.closeAll(); store.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('闲鱼接口采集：mtop分页拉取、字段映射与重复停止', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-goofish-'));
  const store = new PurchaseCollector(path.join(directory, 'erp.sqlite'), path.join(directory, 'exports'));
  const states = [];
  const automation = new PurchaseAutomation({
    directory: path.join(directory, 'auto'),
    profiles: { goofish: { order_url: 'about:blank', need_login_url_contains: ['/login'] } },
    launch: (profile, options) => chromium.launchPersistentContext(profile, { ...options, headless: true }),
    preview: (file, meta) => store.preview(file, { ...meta, automated: true }),
    commitPreview: token => store.commit(token),
    notify: state => states.push(state.state),
  });
  const meta = { platform: 'goofish', startDate: '2026-09-01', endDate: '2026-10-31' };
  try {
    const { page } = await automation.open(meta);
    await page.setContent(`<main>订单</main><script>
      Object.defineProperty(document, 'cookie', { get: () => 'tracknick=tb12345678', configurable: true });
      window.__GOOFISH__ = ${JSON.stringify([
        { commonData: { orderIdStr: 'G001' }, head: { data: { createTime: '2026-09-10 10:00:00', statusViewMsg: '交易成功', userInfo: { userNick: '测试卖家A' } } }, content: { data: { detailInfo: { auctionTitle: '螺丝', skuInfo: 'M3*10' }, priceInfo: { buyAmount: '2', price: '70.00' } } } },
        { commonData: { orderIdStr: 'G002' }, head: { data: { createTime: '2026-10-09 10:00:00', statusViewMsg: '交易成功', userInfo: { userNick: '测试卖家B' } } }, content: { data: { detailInfo: { auctionTitle: '螺母', skuInfo: '' }, priceInfo: { buyAmount: '5', price: '30.00' } } } },
      ])};
      window.lib = { mtop: { H5Request: function(params, success) {
        // page 1 返回全部，page 2+ 重复（触发重复停止）
        success({ ret: ['SUCCESS::调用成功'], data: { items: window.__GOOFISH__ } });
      } } };
    </script>`);

    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'completed', automation.state().message);
    assert.ok(states.includes('running'));
    assert.equal(store.read().count, 2);
    assert.equal(store.read({ month: '2026-09' }).total, 70);
    assert.equal(store.read({ month: '2026-10' }).total, 30);
    const september = store.read({ month: '2026-09' }).rows[0];
    assert.equal(september.item, '螺丝 M3*10');
    assert.equal(september.quantity, 2);
    assert.equal(september.unitPrice, 35);
    assert.equal(september.itemAmount, 70);
    assert.equal(september.freight, 0);
    assert.equal(september.accountLabel, 'tb12345678');
  } finally { await automation.closeAll(); store.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('拼多多接口采集：order_list_v4 字段映射、分单位金额、状态映射', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-pdd-'));
  const store = new PurchaseCollector(path.join(directory, 'erp.sqlite'), path.join(directory, 'exports'));
  const states = [];
  const automation = new PurchaseAutomation({
    directory: path.join(directory, 'auto'),
    profiles: { pdd: { order_url: 'about:blank', need_login_url_contains: ['login'] } },
    launch: (profile, options) => chromium.launchPersistentContext(profile, { ...options, headless: true }),
    preview: (file, meta) => store.preview(file, { ...meta, automated: true }),
    commitPreview: token => store.commit(token),
    notify: state => states.push(state.state),
  });
  const meta = { platform: 'pdd', startDate: '2026-09-01', endDate: '2026-10-31' };
  try {
    const { page } = await automation.open(meta);
    await page.setContent(`<main>订单</main><script>
      Object.defineProperty(document, 'cookie', { get: () => 'pdd_user_id=8979755907', configurable: true });
      window.__PDD__ = [
        { order_sn: 'P001', order_time: 1788969600, shipping_amount: 0, discount_amount: 10, display_amount: 1084, status: 4, tracking_number: 'YT20260910', mall: { mall_name: '测试店铺A' }, order_goods: [ { goods_name: '螺丝', goods_price: 547, goods_number: 2, spec: 'M5*10' } ] },
        { order_sn: 'P002', order_time: 1791129600, shipping_amount: 0, discount_amount: 0, display_amount: 200, status: 2, tracking_number: '', mall: { mall_name: '测试店铺B' }, order_goods: [ { goods_name: '螺母', goods_price: 200, goods_number: 1, spec: '' } ] },
      ];
      window.fetch = async (url) => {
        if (String(url).includes('order_list_v4')) return { ok: true, status: 200, json: async () => ({ orders: window.__PDD__ }) };
        throw new Error('unexpected fetch: ' + url);
      };
    </script>`);

    automation.start(meta); await automation.task;
    assert.equal(automation.state().state, 'completed', automation.state().message);
    assert.ok(states.includes('running'));
    assert.equal(store.read().count, 2);
    assert.equal(store.read({ month: '2026-09' }).total, 10.84);
    assert.equal(store.read({ month: '2026-10' }).total, 2);
    const september = store.read({ month: '2026-09' }).rows[0];
    assert.equal(september.item, '螺丝 M5*10');
    assert.equal(september.quantity, 2);
    assert.equal(september.unitPrice, 5.47);
    assert.equal(september.itemAmount, 10.94);
    assert.equal(september.paidAmount, 10.84);
    assert.equal(september.supplier, '测试店铺A');
    assert.equal(september.status, '交易成功');
    assert.equal(september.trackingNumber, 'YT20260910');
    assert.equal(september.accountLabel, '8979755907');
    const october = store.read({ month: '2026-10' }).rows[0];
    assert.equal(october.status, '待发货');
  } finally { await automation.closeAll(); store.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('账号识别适应宽屏、非链接顶栏、Shadow DOM并正确区分登录状态', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } }), page = await context.newPage();
  const automationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-account-diagnosis-'));
  const automation = new PurchaseAutomation({ directory: automationDirectory, profiles: {}, preview: () => {} });
  const meta = { platform: 'alibaba_1688' };
  try {
    await page.setContent('<div style="position:fixed;left:1200px;top:180px">手机阿里 <span>buyer_main</span> 消息</div><main>订单号 <button>导出当前条件</button></main>');
    assert.equal(await readPurchaseAccount(page, meta.platform), 'buyer_main');
    const report = await inspectPurchaseAccount(page, meta.platform);
    assert.equal(report.diagnostics.width, 1920); assert.equal(report.diagnostics.knownElements, 0); assert.ok(report.diagnostics.fallbackElements > 0);
    await page.setContent('<div id="shadow-host"></div>');
    await page.locator('#shadow-host').evaluate(el => { el.attachShadow({ mode: 'open' }).innerHTML = '<div>手机阿里 <strong>tb34567890</strong> 消息</div>'; });
    assert.equal(await readPurchaseAccount(page, meta.platform), 'tb34567890');
    await page.setContent('<p>订单号</p><button>导出当前条件</button><a>安全退出</a><main>供应商 <span>tb99999999</span></main>');
    await assert.rejects(automation.identify(page, meta, {}), error => error.state === 'needs_review' && /不代表未登录/.test(error.message));
    assert.equal(automation.state().accountNotices.alibaba_1688.state, 'needs_review');
    assert.ok(automation.state().logs.some(entry => entry.message.includes('网页1920×1080')));
    await page.setContent('<p>正在加载页面</p>');
    await assert.rejects(automation.identify(page, meta, {}), error => error.state === 'needs_review' && /登录状态尚不明确/.test(error.message));
    await page.setContent('<a>请登录</a>');
    await assert.rejects(automation.identify(page, meta, {}), error => error.state === 'needs_login');
    await page.setContent('<form id="login-form"><input placeholder="账号"></form>');
    await assert.rejects(automation.identify(page, meta, { need_login_selectors: ['#login-form'] }), error => error.state === 'needs_login');
    await page.setContent('<p>安全验证：请完成验证</p>');
    await assert.rejects(automation.identify(page, meta, {}), error => error.state === 'needs_verification');
    await page.setContent('<div>手机阿里 <span>tb34567890</span> 消息</div><footer>收不到验证码怎么办</footer>');
    assert.equal(await readPurchaseAccount(page, meta.platform), 'tb34567890');
  } finally { await automation.closeAll(); await browser.close(); fs.rmSync(automationDirectory, { recursive: true, force: true }); }
});

test('采集日志持久化、错误脱敏与重启恢复，不依赖平台页面', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-logs-'));
  const options = { directory, profiles: {}, preview: () => {}, launch: async () => { throw new Error('浏览器启动模拟失败 token=secret123 https://example.invalid/?cookie=hidden'); } };
  try {
    const automation = new PurchaseAutomation(options);
    automation.start({ platform: 'alibaba_1688', account: '测试采购账号', month: '2026-09' }); await automation.task;
    assert.equal(automation.state().state, 'failed');
    const text = JSON.stringify(automation.state().logs);
    assert.match(text, /启动模拟失败/); assert.doesNotMatch(text, /secret123|cookie=hidden|测试采购账号/);
    const restored = new PurchaseAutomation(options);
    assert.deepEqual(restored.state().logs, automation.state().logs);
    assert.equal(restored.state().logs.at(-1).level, 'error');
    for (let i = 0; i < 305; i++) restored.log(`测试进度${i}`);
    assert.equal(restored.state().logs.length, 300);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
