import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/renderer/feature-help-content.js'), 'utf8'), context);
const guides = context.window.erpFeatureHelpContent;

test('every navigable view has separate usable manual and principle content', () => {
  assert.deepEqual(Object.keys(guides).sort(), ['home', 'dashboard', 'inventory', 'sales', 'business', 'finance', 'purchase', 'invoice', 'settings'].sort());
  for (const [view, guide] of Object.entries(guides)) {
    assert.ok(guide.title && guide.summary && guide.sources.length, view);
    for (const mode of ['manual', 'principle']) {
      assert.ok(guide[mode].length >= 2, `${view}:${mode}`);
      for (const section of guide[mode]) {
        assert.ok(section.title && section.items.length, `${view}:${mode}`);
        assert.ok(section.items.every(text => typeof text === 'string' && text.length > 10));
      }
    }
  }
});

test('purchase help discloses current financial summary and rollback limits', () => {
  const text = JSON.stringify(guides.purchase);
  assert.match(text, /摘要.*重复计款/);
  assert.match(text, /撤回.*不会.*工作簿/);
  assert.match(text, /补齐.*不.*账号/);
  assert.match(text, /客户端.*本机库/);
});

test('shop onboarding help puts login before store settings and preserves unknown tax data', () => {
  const text = JSON.stringify(guides.finance);
  assert.match(text, /添加店铺.*直接.*千牛.*登录/);
  assert.match(text, /登录后.*读取/);
  assert.match(text, /税号.*待确认/);
  assert.match(text, /取消.*不.*店铺/);
  assert.match(text, /默认.*不.*定时/);
  assert.match(text, /真实.*身份.*未.*验收/);
});

test('downloadable manuals are exported from the same local content source', () => {
  const allFile = path.join(root, 'docs/feature-manual.md');
  const salesFile = path.join(root, 'docs/taobao-sales-collection.md');
  assert.equal(fs.existsSync(allFile), true, '应提供可独立阅读的功能说明书');
  assert.equal(fs.existsSync(salesFile), true, '应提供淘宝销售额下载流程文档');
  const all = fs.readFileSync(allFile, 'utf8');
  const sales = fs.readFileSync(salesFile, 'utf8');
  for (const guide of Object.values(guides)) {
    assert.ok(all.includes(`## ${guide.title}`));
    for (const mode of ['manual', 'principle']) {
      for (const section of guide[mode]) {
        for (const text of section.items) {
          assert.ok(all.includes(text), `全功能说明应与界面内容一致：${guide.title}`);
          if (guide === guides.finance) assert.ok(sales.includes(text), '淘宝说明应与界面内容一致');
        }
      }
    }
  }
});
