import { validateDingTalkSettings } from './settings.mjs';
import { sendDingTalkAppRobotMessage } from '../../core/dingtalk-app-robot.js';
import { sendDingTalkWebhookMarkdown } from '../../core/dingtalk.js';

function botFlags(secrets) {
  return {
    dingtalkClientId: Boolean(secrets?.dingtalkClientId),
    dingtalkClientSecret: Boolean(secrets?.dingtalkClientSecret),
    dingtalkWebhook: Boolean(secrets?.dingtalkWebhook)
  };
}

// 与云仓库存机器人共用配置和群目标，不修改进程全局环境变量。
export async function deliverInvoiceReminder({ settings, secrets, title, text,
  sendApp = sendDingTalkAppRobotMessage, sendWebhook = sendDingTalkWebhookMarkdown }) {
  const validation = validateDingTalkSettings(settings, botFlags(secrets));
  if (!validation.ok) throw new Error(`云仓钉钉机器人未配置完整：${validation.errors.join('；')}`);
  const mode = validation.value.deliveryMode;
  if (mode === 'app') {
    const result = await sendApp({
      clientId: secrets.dingtalkClientId,
      clientSecret: secrets.dingtalkClientSecret,
      robotCode: validation.value.dingtalkRobotCode,
      conversationId: validation.value.dingtalkConversationId,
      msgKey: 'sampleMarkdown',
      msgParam: { title, text }
    });
    if (result?.skipped || result == null) throw new Error('钉钉企业应用机器人未发送');
    if (result.code && String(result.code) !== '0') throw new Error(`钉钉企业应用机器人拒绝发送：${String(result.code).slice(0, 80)}`);
  } else {
    const result = await sendWebhook({ webhook: secrets.dingtalkWebhook,
      webhookSecret: secrets.dingtalkWebhookSecret || '', title, text });
    if (result?.skipped || result == null) throw new Error('钉钉 Webhook 未发送');
    if (result.errcode !== 0) throw new Error('钉钉 Webhook 未确认发送成功');
  }
  return { sent: true, mode };
}
