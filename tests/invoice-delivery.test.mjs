import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverInvoiceReminder } from '../desktop/shared/invoice-delivery.mjs';

const settings = { deliveryMode: 'app', dingtalkRobotCode: 'robot', dingtalkConversationId: 'group' };
const secrets = { dingtalkClientId: 'client', dingtalkClientSecret: 'secret' };
const message = { title: '开票巡检', text: '店口五金店：待处理 2' };

test('invoice reminder uses inventory app robot and its group, not webhook', async () => {
  let call;
  const result = await deliverInvoiceReminder({ settings, secrets, ...message,
    sendApp: async payload => { call = payload; return { processQueryKey: 'accepted' }; },
    sendWebhook: async () => { throw new Error('wrong channel'); }
  });
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'app');
  assert.deepEqual(call, { clientId: 'client', clientSecret: 'secret', robotCode: 'robot', conversationId: 'group', msgKey: 'sampleMarkdown', msgParam: message });
});

test('webhook mode uses inventory webhook credentials without process globals', async () => {
  let call;
  const result = await deliverInvoiceReminder({ settings: { deliveryMode: 'webhook' }, secrets: { dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=x', dingtalkWebhookSecret: 'key' }, ...message,
    sendApp: async () => { throw new Error('wrong channel'); },
    sendWebhook: async payload => { call = payload; return { errcode: 0 }; }
  });
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'webhook');
  assert.equal(call.webhookSecret, 'key');
  assert.equal(call.webhook.includes('access_token=x'), true);
});

test('missing bot config and skipped send must never be reported as sent', async () => {
  await assert.rejects(() => deliverInvoiceReminder({ settings, secrets: {}, ...message }), /Client ID|Client Secret/);
  await assert.rejects(() => deliverInvoiceReminder({ settings: { deliveryMode: 'webhook' }, secrets: { dingtalkWebhook: 'x' }, ...message,
    sendWebhook: async () => ({ skipped: true }) }), /未发送/);
});

test('DingTalk application rejects report when API returns an error envelope', async () => {
  await assert.rejects(() => deliverInvoiceReminder({ settings, secrets, ...message,
    sendApp: async () => ({ code: 'InvalidParameter', message: 'group invalid' }) }), /InvalidParameter/);
});
