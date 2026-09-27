import { buildMonthlyMarkdown } from './erp/reports.js';
import { sendDingTalkMarkdown } from './dingtalk.js';

async function main() {
  const month = process.argv[2] || new Date().toISOString().slice(0, 7);
  console.log('📊 生成月度销售报表:', month);

  const markdown = buildMonthlyMarkdown(month);
  console.log(markdown.text.split('\n').slice(0, 8).join('\n'));

  const result = await sendDingTalkMarkdown({
    title: markdown.title,
    text: markdown.text,
  });
  console.log('✅ 钉钉发送结果:', result);
}

main().catch((err) => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
