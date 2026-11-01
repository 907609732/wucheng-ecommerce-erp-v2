import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import axios from 'axios';
import * as SMS from '@alicloud/dysmsapi20170525';
import * as Voice from '@alicloud/dyvmsapi20170525';
import {normalizeReminderSettings,reminderChannelStates,createWarehouseReminderSenders} from '../desktop/shared/warehouse-reminder-senders.mjs';
const employee={login:'demo@example.test',name:'测试员工',email:'demo@example.test',mobile:'13800000000',dingtalkUserId:'test-user',task:'核对库存',deadline:'18:00'};
const secrets={smtpPassword:'synthetic-only',aliyunAccessKeyId:'synthetic-only',aliyunAccessKeySecret:'synthetic-only',dingtalkClientId:'synthetic-only',dingtalkClientSecret:'synthetic-only'};
const settings={dingtalkRobotCode:'test-robot',warehouseReminders:{smtpHost:'smtp.example.test',smtpUser:'demo',smtpFrom:'sender@example.test',smsSignName:'测试签名',smsTemplateCode:'SMS_TEST',phoneTemplateCode:'TTS_TEST',smsTemplateParams:'{"name":"{name}","date":"{date}"}',phoneTemplateParams:'{"task":"{task}","deadline":"{deadline}"}'}};
const payload={employee,message:'测试消息，不实际发送',businessDate:'2026-10-26'};

test('channel validation rejects malformed fields and only reports configured channels',()=>{
  assert.throws(()=>normalizeReminderSettings({smtpHost:'smtp://invalid'}));
  assert.throws(()=>normalizeReminderSettings({smtpPort:0}));
  assert.throws(()=>normalizeReminderSettings({phoneTemplateParams:'[]'}));
  assert.equal(reminderChannelStates({},{}).email.ready,false);
  assert(Object.values(reminderChannelStates(settings.warehouseReminders,secrets,settings)).every(c=>c.ready));
});
test('all four adapters use established libraries with correct receiver and return only a receipt',async t=>{
  const SMSClient=SMS.default?.default||SMS.default,VoiceClient=Voice.default?.default||Voice.default;
  const originals={smtp:nodemailer.createTransport,post:axios.post,sms:SMSClient.prototype.sendSmsWithOptions,phone:VoiceClient.prototype.singleCallByTtsWithOptions},calls=[];
  t.after(()=>{nodemailer.createTransport=originals.smtp;axios.post=originals.post;SMSClient.prototype.sendSmsWithOptions=originals.sms;VoiceClient.prototype.singleCallByTtsWithOptions=originals.phone;});
  nodemailer.createTransport=options=>{assert.equal(options.requireTLS,false);return {sendMail:async message=>{calls.push(['email',message]);return {accepted:[employee.email],messageId:'smtp-id'};},close(){}};};
  axios.post=async(url,body,options)=>{if(url.endsWith('accessToken'))return {data:{accessToken:'synthetic-token'}};assert(url.endsWith('/oToMessages/batchSend'));assert.equal(options.timeout,15000);calls.push(['dingtalk',body]);return {data:{processQueryKey:'ding-id'}};};
  SMSClient.prototype.sendSmsWithOptions=async(request,runtime)=>{calls.push(['sms',request]);assert.equal(runtime.autoretry,false);assert.equal(runtime.maxAttempts,1);return {body:{code:'OK',bizId:'sms-id'}};};
  VoiceClient.prototype.singleCallByTtsWithOptions=async(request,runtime)=>{calls.push(['phone',request]);assert.equal(runtime.autoretry,false);assert.equal(request.playTimes,1);return {body:{code:'OK',callId:'phone-id'}};};
  const senders=createWarehouseReminderSenders({readSettings:()=>settings,readSecrets:async()=>secrets});
  assert.deepEqual(await senders.email(payload),{receiptId:'smtp-id'});
  assert.deepEqual(await senders.dingtalk(payload),{receiptId:'ding-id'});
  assert.deepEqual(await senders.sms(payload),{receiptId:'sms-id'});
  assert.deepEqual(await senders.phone(payload),{receiptId:'phone-id'});
  assert.equal(calls[0][1].to,employee.email);assert.deepEqual(calls[1][1].userIds,[employee.dingtalkUserId]);
  assert.equal(calls[2][1].phoneNumbers,employee.mobile);assert.deepEqual(JSON.parse(calls[2][1].templateParam),{name:employee.name,date:payload.businessDate});
  assert.equal(calls[3][1].calledNumber,employee.mobile);assert.deepEqual(JSON.parse(calls[3][1].ttsParam),{task:employee.task,deadline:employee.deadline});
});
