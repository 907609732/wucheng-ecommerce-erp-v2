import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/renderer/feature-help-content.js'), 'utf8'), context);
const guides = context.window.erpFeatureHelpContent;
const preface = '本文由 desktop/renderer/feature-help-content.js 生成，与云仓设置中的使用说明 / 技术原理共用内容源。维护时修改该文件，再运行 npm run docs:features。平台步骤来自用户截图，实现说明来自当前源码；不代表真实平台自动下载已经验收。\n\n';
const all = ['# ERP 功能说明书与技术原理\n\n', preface];
for (const [view, guide] of Object.entries(guides)) {
  const lines = [`## ${guide.title}\n\n${guide.summary}\n\n`];
  for (const [mode, name] of [['manual', '说明书'], ['principle', '技术原理']]) {
    lines.push(`### ${name}\n\n`);
    for (const section of guide[mode]) {
      lines.push(`#### ${section.title}\n\n`);
      if (section.warning) lines.push('> 注意：以下边界必须在操作前核对。\n\n');
      section.items.forEach((text, index) => lines.push(`${section.ordered ? `${index + 1}.` : '-'} ${text}\n`));
      lines.push('\n');
    }
  }
  lines.push('### 说明依据 / 维护入口\n\n');
  for (const source of guide.sources) lines.push(`- ${source}\n`);
  lines.push('\n---\n\n');
  all.push(...lines);
}
const files = [['docs/feature-manual.md', all]];
for (const [file, lines] of files) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('').trimEnd()+'\n', 'utf8');
}
console.log(JSON.stringify({ ok: true, files: files.map(([file]) => path.join(root, file)), views: Object.keys(guides) }));
