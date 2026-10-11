import test from 'node:test';
import assert from 'node:assert/strict';

import * as loaded from '../desktop/shared/finance-identity.mjs';
const analyze = snapshot => {
  assert.equal(typeof loaded.analyzeFinanceIdentity, 'function', '必须导出 analyzeFinanceIdentity');
  return loaded.analyzeFinanceIdentity(snapshot);
};
const BILL_URL = 'https://qn.taobao.com/home.htm/whale-accountant/bill/summary?billDirection=income&billType=month';
const fields = ['name', 'account', 'shopId', 'entity', 'taxId', 'entityType', 'taxpayer'];
const emptyIdentity = () => Object.fromEntries(fields.map(field => [field, '']));
const page = (entries = [], over = {}) => ({ url: BILL_URL, title: '千牛 · 收支账单', text: '收入账单 月汇总', entries, ...over });
const header = entry => ({ ...entry, identitySource: 'semantic-current-shop-header', frameIndex: 0 });
const trusted = (identityRole, value, over = {}) => header({ identityRole, trusted: true, value, ...over });

test('登录墙、登录地址与验证码优先转人工，不暴露残留身份', () => {
  const identityEntries = [trusted('shopName', '旧店铺'), trusted('account', 'old-account')];
  const cases = [
    [page(identityEntries, { text: '请扫码登录' }), 'needs_login'],
    [page(identityEntries, { url: 'https://login.taobao.com/member/login.jhtml', text: '' }), 'needs_login'],
    [page(identityEntries, { entries: [{ text: '密码登录' }], text: '' }), 'needs_login'],
    [page(identityEntries, { text: '请拖动滑块完成验证' }), 'needs_captcha'],
    [page(identityEntries, { text: '请登录并输入验证码' }), 'needs_captcha'],
    [page(identityEntries, { title: '短信验证', text: '' }), 'needs_captcha']
  ];
  for (const [input, state] of cases) {
    const result = analyze(input);
    assert.equal(result.state, state);
    assert.deepEqual(result.identity, emptyIdentity());
    assert.deepEqual(result.sources, []);
    assert.match(result.message, /人工|登录|验证/);
  }
});

test('可信采集项只回填明确身份，账单页进入小卡片确认', () => {
  const result = analyze(page([
    trusted('shopName', '五成家居店'), trusted('account', 'wc-shop'),
    trusted('shopId', '001234'), trusted('entity', '五成贸易有限公司'),
    trusted('taxId', '91310000TEST000001'),
    trusted('entityType', '企业'), trusted('taxpayer', '一般纳税人')
  ]));
  assert.equal(result.state, 'needs_confirmation');
  assert.deepEqual(result.identity, {
    name: '五成家居店', account: 'wc-shop', shopId: '001234',
    entity: '五成贸易有限公司', taxId: '91310000TEST000001', entityType: '', taxpayer: ''
  });
  assert.deepEqual(result.missing, ['entityType', 'taxpayer']);
  assert.deepEqual(result.sources.map(item => item.field), ['name', 'account', 'shopId', 'entity', 'taxId']);
  assert.ok(result.sources.every(item => item.source === 'trusted-entry'));
  assert.match(result.message, /确认/);
});

test('语义当前店铺页头内的明确标签支持文本与只读 label/value，不用 CSS 猜身份', () => {
  const result = analyze(page([
    { text: '店铺名称：五成家居店', tag: 'span' },
    { text: '登录账号 wc-shop', tag: 'span' },
    { aria: '店铺ID', value: '001234', tag: 'input', readOnly: true },
    { text: '经营主体：五成贸易有限公司', tag: 'span' },
    { title: '纳税人识别号', value: '91310000TEST000001', tag: 'input', readOnly: true }
  ].map(header)));
  assert.equal(result.state, 'needs_confirmation');
  assert.deepEqual(result.identity, {
    name: '五成家居店', account: 'wc-shop', shopId: '001234',
    entity: '五成贸易有限公司', taxId: '91310000TEST000001', entityType: '', taxpayer: ''
  });
  assert.ok(result.sources.every(item => item.source === 'visible-label' && typeof item.label === 'string'));
});

test('安全昵称 cookie 解码为账号，缺店名仍可确认补填且不泄漏其他凭据', () => {
  for (const cookieName of ['_nk_']) {
    const input = page([], { accountCookies: [
      { name: 'cookie2', value: 'SECRET_SESSION_123' },
      { name: '_m_h5_tk', value: 'SECRET_TOKEN_456' },
      { name: cookieName, value: encodeURIComponent('五成+主账号') }
    ] });
    const result = analyze(input);
    assert.equal(result.state, 'needs_confirmation');
    assert.equal(result.identity.account, '五成+主账号');
    assert.equal(result.identity.name, '');
    assert.deepEqual(result.sources, [{ field: 'account', source: 'account-cookie', label: cookieName }]);
    assert.ok(result.missing.includes('name'));
    assert.match(result.message, /补|名称|店铺名/);
    assert.equal(/SECRET_|cookie2|_m_h5_tk|accountCookies/.test(JSON.stringify(result)), false);
    assert.equal(JSON.stringify(input.accountCookies).includes('SECRET_SESSION_123'), true);
  }
});

test('任一明确身份字段有不同候选即等待，不能挑选一个保存', () => {
  for (const role of ['shopName', 'account', 'shopId', 'entity', 'taxId']) {
    const result = analyze(page([
      trusted('shopName', '共同店铺'),
      trusted(role, '候选甲'), trusted(role, '候选乙')
    ]));
    assert.equal(result.state, 'waiting', role);
    assert.deepEqual(result.identity, emptyIdentity(), role);
    assert.match(result.message, /冲突|多个|不一致/);
  }
  const crossSource = analyze(page([header({ text: '当前登录账号：visible-account' })], {
    accountCookies: [{ name: '_nk_', value: 'cookie-account' }]
  }));
  assert.equal(crossSource.state, 'waiting');
  assert.deepEqual(crossSource.identity, emptyIdentity());
  const cookieConflict = analyze(page([], { accountCookies: [
    { name: '_nk_', value: 'account-a' }, { name: '_nk_', value: 'account-b' }
  ] }));
  assert.equal(cookieConflict.state, 'waiting');
  assert.deepEqual(cookieConflict.identity, emptyIdentity());
  const repeated = analyze(page([trusted('shopName', '同一店铺'), trusted('shopName', '同一店铺'), trusted('account', 'same-account')]));
  assert.equal(repeated.state, 'needs_confirmation');
  assert.equal(repeated.identity.name, '同一店铺');
  assert.equal(repeated.sources.filter(source => source.field === 'name').length, 1);
});

test('本地 HTTP 账单页仅在 browser 显式可信测试 flag 下进入确认', () => {
  const entries = [{ text: '店铺名称：仿真店铺' }, { text: '经营主体名称：仿真企业' }, { text: '登录账号：test-account' }].map(header);
  const local = page(entries, { url: 'http://127.0.0.1:32123/finance', trustedTestOrigin: true });
  assert.equal(analyze(local).state, 'needs_confirmation');
  assert.equal(analyze(local).identity.entity, '仿真企业');
  assert.equal(analyze({ ...local, trustedTestOrigin: false }).state, 'waiting');
  assert.equal(analyze({ ...local, trustedTestOrigin: 'true' }).state, 'waiting');
  assert.equal(analyze({ ...local, url: 'https://example.com/finance' }).state, 'waiting');
  assert.equal(analyze({ ...local, text: '', title: '未知页面' }).state, 'waiting');
  assert.equal(analyze({ ...local, text: '请扫码登录' }).state, 'needs_login');
  assert.equal(analyze({ ...local, text: '请输入验证码' }).state, 'needs_captcha');
});

test('空值、占位符、非字符串与非法 cookie 编码不能成为身份', () => {
  for (const value of ['', '  ', '-', '--', '暂无', '未设置', '未提供', 'null', 'undefined', '***', null, 123, {}]) {
    const result = analyze(page([trusted('shopName', value), trusted('account', value)]));
    assert.equal(result.state, 'waiting', String(value));
    assert.deepEqual(result.identity, emptyIdentity());
    assert.deepEqual(result.sources, []);
  }
  for (const cookies of [null, 'not-an-array', [null], [{ name: '_nk_', value: '%E0%A4' }], [{ name: '_nk_', value: '%20' }]]) {
    const result = analyze(page([], { accountCookies: cookies }));
    assert.equal(result.state, 'waiting');
    assert.equal(result.identity.account, '');
  }
});

test('全局正文、订单商家、任意账号与未信任 CSS/role 提示不作登录身份', () => {
  const input = page([
    { text: '商家名称：订单商家' }, { text: '买家账号：buyer-account' },
    { text: '订单中的店铺名称：订单店铺' },
    { text: '店铺名称：表格商家', tag: 'td', row: 0 },
    { text: '账号：表格账号', tag: 'span', row: 1 },
    { value: 'PASSWORD_CREDENTIAL', type: 'password', aria: '登录账号', tag: 'input' },
    { text: 'untrusted-shop', identityRole: 'shopName', trusted: false },
    { text: 'not-boolean-trust', identityRole: 'account', trusted: 'true' },
    { text: 'css-only-account', cls: 'current-shop account', id: 'shopName', name: 'loginId' }
  ], { text: '收支账单 店铺名称：正文店 登录账号：body-account 店铺ID：9999', title: '商家中心 body-account' });
  const result = analyze(input);
  assert.equal(result.state, 'waiting');
  assert.deepEqual(result.identity, emptyIdentity());
  assert.equal(JSON.stringify(result).includes('PASSWORD_CREDENTIAL'), false);
  const withCookie = analyze({ ...input, accountCookies: [{ name: '_nk_', value: 'real-account' }] });
  assert.equal(withCookie.state, 'needs_confirmation');
  assert.equal(withCookie.identity.account, 'real-account');
  assert.equal(withCookie.identity.name, '');
});

test('聚合正文不能冒充独立身份标签，trusted 项也不把标签本身存成店名', () => {
  const aggregate = analyze(page([
    { text: '店铺名称：某订单商家 登录账号：某订单买家', tag: 'div' },
    { text: '账号：买家\n订单号：123456', tag: 'div' }
  ]));
  assert.equal(aggregate.state, 'waiting');
  assert.deepEqual(aggregate.identity, emptyIdentity());
  const named = analyze(page([trusted('shopName', '', { text: '店铺名称：五成家居店' }), trusted('account', 'wc-account')]));
  assert.equal(named.state, 'needs_confirmation');
  assert.equal(named.identity.name, '五成家居店');
});

test('登录失效或尚未登录提示不能被残留 cookie 当成登录成功', () => {
  for (const text of ['登录已失效', '会话过期，请重新登录', '当前未登录', '请重新登录']) {
    const result = analyze(page([trusted('shopName', '残留店铺')], {
      text, accountCookies: [{ name: '_nk_', value: 'stale-account' }]
    }));
    assert.equal(result.state, 'needs_login', text);
    assert.deepEqual(result.identity, emptyIdentity());
    assert.deepEqual(result.sources, []);
  }
});

test('未知页面即使有可信昵称也等待，只有账单页面允许确认', () => {
  for (const url of ['about:blank', 'not a URL', 'https://qn.taobao.com/home.htm', 'https://example.com' + new URL(BILL_URL).pathname]) {
    const result = analyze(page([trusted('account', 'known-account')], { url }));
    assert.equal(result.state, 'waiting', url);
  }
  const billWithoutIdentity = analyze(page());
  assert.equal(billWithoutIdentity.state, 'waiting');
  assert.deepEqual(billWithoutIdentity.identity, emptyIdentity());
  assert.deepEqual(analyze(page([], { accountCookies: [{ name: 'cookie2', value: 'SESSION_SECRET' }] })).identity, emptyIdentity());
});

test('cookie 只解码为字面字符串，不执行看似 JavaScript 的账号内容', () => {
  const literal = 'globalThis.__financeIdentityExecuted = true';
  const before = globalThis.__financeIdentityExecuted;
  const result = analyze(page([], { accountCookies: [{ name: '_nk_', value: encodeURIComponent(literal) }] }));
  assert.equal(result.identity.account, literal);
  assert.equal(globalThis.__financeIdentityExecuted, before);
});

test('纯函数不修改冻结输入，返回值独立且不带原始采集项或凭据', () => {
  const entry = Object.freeze(header({ text: '当前店铺名称：五成家居店', selector: '#header', id: 'arbitrary-id' }));
  const cookie = Object.freeze({ name: '_nk_', value: 'wc-account', domain: '.taobao.com', httpOnly: true });
  const input = Object.freeze(page(Object.freeze([entry]), { accountCookies: Object.freeze([cookie]) }));
  const result = analyze(input);
  assert.equal(result.state, 'needs_confirmation');
  assert.deepEqual(Object.keys(loaded), ['analyzeFinanceIdentity']);
  assert.equal(/selector|httpOnly|domain|arbitrary-id|accountCookies/.test(JSON.stringify(result)), false);
  result.identity.name = '调用方修改';
  assert.equal(analyze(input).identity.name, '五成家居店');
});

test('confirmation requires a stable account or shop ID, not a name alone', () => {
  const nameOnly = analyze(page([{ text: '店铺名称：未核验店铺' }]));
  assert.equal(nameOnly.state, 'waiting');
  const shopId = analyze(page([header({ text: '店铺ID：000123' })]));
  assert.equal(shopId.state, 'needs_confirmation');
  assert.equal(shopId.identity.shopId, '000123');
  assert.equal(shopId.identity.name, '');
});

test('Taobao ignores Xianyu nickname cookies and editable form inputs', () => {
  const wrongCookie = analyze(page([], { accountCookies: [{ name: 'tracknick', value: 'xianyu-account' }] }));
  assert.equal(wrongCookie.state, 'waiting');
  const form = analyze(page([
    { tag: 'input', type: 'text', aria: '登录账号', value: 'typed-not-authenticated' },
    { tag: 'textarea', text: '店铺名称', value: 'typed-shop' }
  ]));
  assert.equal(form.state, 'waiting');
  assert.equal(form.identity.account, '');
});

test('a bill URL and leftover nickname do not authorize confirmation before the page renders', () => {
  const result = analyze(page([], { text: '', accountCookies: [{ name: '_nk_', value: 'stale-account' }] }));
  assert.equal(result.state, 'waiting');
});

test('订单 div、非 table 卡片、网格其他商家的独立标签不得拼接当前昵称', () => {
  const result = analyze(page([
    { tag: 'div', text: '店铺名称：订单对方店铺', row: -1 },
    { tag: 'span', text: '经营主体：订单对方企业', row: -1 },
    { tag: 'div', role: 'gridcell', text: '税号：OTHER-TAX', row: -1 },
    { tag: 'span', identityRole: 'shopId', trusted: true, value: 'unverified-id' }
  ], { accountCookies: [{ name: '_nk_', value: 'current-login-account' }] }));
  assert.equal(result.state, 'needs_confirmation');
  assert.equal(result.identity.account, 'current-login-account');
  for (const key of ['name', 'entity', 'taxId', 'shopId']) assert.equal(result.identity[key], '', key);
  assert.deepEqual(result.sources, [{ field: 'account', source: 'account-cookie', label: '_nk_' }]);
});

test('空快照等待识别，字段完整且不猜默认税务资料', () => {
  for (const input of [undefined, null, {}, { entries: null }, { entries: 'not-an-array' }]) {
    const result = analyze(input);
    assert.equal(result.state, 'waiting');
    assert.deepEqual(result.identity, emptyIdentity());
    assert.deepEqual(result.missing, fields);
    assert.deepEqual(result.sources, []);
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message);
    assert.deepEqual(Object.keys(result).sort(), ['identity', 'message', 'missing', 'sources', 'state']);
  }
});
