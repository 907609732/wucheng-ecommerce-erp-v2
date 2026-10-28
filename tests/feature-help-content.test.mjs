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
  assert.deepEqual(Object.keys(guides).sort(), ['dashboard', 'inventory', 'sales', 'attendance', 'settings'].sort());
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

test('downloadable manuals are exported from the same local content source', () => {
  const allFile = path.join(root, 'docs/feature-manual.md');
  assert.equal(fs.existsSync(allFile), true, '应提供可独立阅读的功能说明书');
  const all = fs.readFileSync(allFile, 'utf8');
  for (const guide of Object.values(guides)) {
    assert.ok(all.includes(`## ${guide.title}`));
    for (const mode of ['manual', 'principle']) {
      for (const section of guide[mode]) {
        for (const text of section.items) {
          assert.ok(all.includes(text), `全功能说明应与界面内容一致：${guide.title}`);
        }
      }
    }
  }
});
