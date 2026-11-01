import nodemailer from 'nodemailer';
import axios from 'axios';
import * as SMS from '@alicloud/dysmsapi20170525';
import * as Voice from '@alicloud/dyvmsapi20170525';

const clientClass = module => module.default?.default || module.default;
const cleanError = (message,definiteFailure=true) => Object.assign(Error(message),{definiteFailure});
export function normalizeReminderSettings(input={}) {
  const value={smtpHost:'',smtpPort:465,smtpSecure:true,smtpUser:'',smtpFrom:'',smsSignName:'',smsTemplateCode:'',smsTemplateParams:'{"name":"{name}","date":"{date}"}',phoneTemplateCode:'',phoneTemplateParams:'{"name":"{name}","date":"{date}"}',phoneCalledShowNumber:'',...input};
  for(const key of ['smtpHost','smtpUser','smtpFrom','smsSignName','smsTemplateCode','smsTemplateParams','phoneTemplateCode','phoneTemplateParams','phoneCalledShowNumber'])value[key]=String(value[key]||'').trim();
  value.smtpPort=Number(value.smtpPort);value.smtpSecure=value.smtpSecure!==false;
  if(!Number.isInteger(value.smtpPort)||value.smtpPort<1||value.smtpPort>65535)throw cleanError('SMTP端口无效');
  if(value.smtpHost&&(!/^[a-zA-Z0-9.-]+$/.test(value.smtpHost)||value.smtpHost.length>253))throw cleanError('SMTP主机格式无效');
  if(value.smtpFrom&&!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value.smtpFrom))throw cleanError('发件邮箱格式无效');
  for(const key of ['smsTemplateParams','phoneTemplateParams']){
    if(value[key].length>2000)throw cleanError('模板变量过长');
    let parsed;try{parsed=JSON.parse(value[key]||'{}');}catch{throw cleanError('模板变量必须是JSON对象');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.values(parsed).some(v=>typeof v!=='string'))throw cleanError('模板变量必须是字符串键值对象');
  }
  return Object.fromEntries(Object.keys(normalizeReminderSettings.keys).map(key=>[key,value[key]]));
}
normalizeReminderSettings.keys={smtpHost:1,smtpPort:1,smtpSecure:1,smtpUser:1,smtpFrom:1,smsSignName:1,smsTemplateCode:1,smsTemplateParams:1,phoneTemplateCode:1,phoneTemplateParams:1,phoneCalledShowNumber:1};
export function reminderChannelStates(settings,secrets,businessSettings={}) {
  const s=normalizeReminderSettings(settings),credentials=Boolean(secrets.aliyunAccessKeyId&&secrets.aliyunAccessKeySecret);
  const ready={email:Boolean(s.smtpHost&&s.smtpUser&&s.smtpFrom&&secrets.smtpPassword),dingtalk:Boolean(secrets.dingtalkClientId&&secrets.dingtalkClientSecret&&businessSettings.dingtalkRobotCode),sms:Boolean(credentials&&s.smsSignName&&s.smsTemplateCode),phone:Boolean(credentials&&s.phoneTemplateCode)};
  const reasons={email:'待配置 SMTP 主机、发件账号、发件地址和授权密码',dingtalk:'待配置企业应用 Client ID、Client Secret 和 Robot Code；员工需绑定钉钉 User ID',sms:'待配置阿里云凭据、短信签名与已审核模板',phone:'待配置阿里云凭据与已审核语音模板'};
  return Object.fromEntries(Object.entries(ready).map(([key,ready])=>[key,{ready,reason:ready?'已配置，实际接收以服务商回执为准':reasons[key]}]));
}
const params=(template,employee,date)=>JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(template||'{}')).map(([key,value])=>[key,value.replaceAll('{name}',employee.name).replaceAll('{date}',date).replaceAll('{task}',employee.task).replaceAll('{deadline}',employee.deadline)])));
export function createWarehouseReminderSenders({readSettings,readSecrets}) {
  const current=async()=>({settings:readSettings(),secrets:await readSecrets()});
  return {
    email:async({employee,message,businessDate})=>{
      const {settings,secrets}=await current(),s=normalizeReminderSettings(settings.warehouseReminders);
      const transport=nodemailer.createTransport({host:s.smtpHost,port:s.smtpPort,secure:s.smtpSecure,requireTLS:!s.smtpSecure,auth:{user:s.smtpUser,pass:secrets.smtpPassword},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true});
      try{const sent=await transport.sendMail({from:s.smtpFrom,to:employee.email,subject:`云仓任务提醒 ${businessDate}`,text:message});if(!sent.accepted?.length)throw cleanError('邮件未被SMTP接受');return {receiptId:sent.messageId};}finally{transport.close();}
    },
    dingtalk:async({employee,message})=>{
      const {settings,secrets}=await current();
      const auth=await axios.post('https://api.dingtalk.com/v1.0/oauth2/accessToken',{appKey:secrets.dingtalkClientId,appSecret:secrets.dingtalkClientSecret},{timeout:15000});
      if(!auth.data?.accessToken)throw cleanError('钉钉认证未通过');
      const result=await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',{robotCode:settings.dingtalkRobotCode,userIds:[employee.dingtalkUserId],msgKey:'sampleText',msgParam:JSON.stringify({content:message})},{headers:{'x-acs-dingtalk-access-token':auth.data.accessToken},timeout:15000});
      if(!result.data?.processQueryKey)throw cleanError('钉钉未返回受理记录',false);
      return {receiptId:result.data.processQueryKey};
    },
    sms:async({employee,businessDate})=>{
      const {settings,secrets}=await current(),s=normalizeReminderSettings(settings.warehouseReminders),Client=clientClass(SMS);
      const client=new Client({accessKeyId:secrets.aliyunAccessKeyId,accessKeySecret:secrets.aliyunAccessKeySecret,regionId:'cn-hangzhou',endpoint:'dysmsapi.aliyuncs.com'});
      const result=await client.sendSmsWithOptions(new SMS.SendSmsRequest({phoneNumbers:employee.mobile,signName:s.smsSignName,templateCode:s.smsTemplateCode,templateParam:params(s.smsTemplateParams,employee,businessDate)}),{autoretry:false,maxAttempts:1,readTimeout:15000,connectTimeout:10000});
      if(result.body?.code!=='OK')throw cleanError('短信服务拒绝了请求');
      return {receiptId:result.body.bizId||result.body.requestId};
    },
    phone:async({employee,businessDate})=>{
      const {settings,secrets}=await current(),s=normalizeReminderSettings(settings.warehouseReminders),Client=clientClass(Voice);
      const client=new Client({accessKeyId:secrets.aliyunAccessKeyId,accessKeySecret:secrets.aliyunAccessKeySecret,regionId:'cn-hangzhou',endpoint:'dyvmsapi.aliyuncs.com'});
      const result=await client.singleCallByTtsWithOptions(new Voice.SingleCallByTtsRequest({calledNumber:employee.mobile,...(s.phoneCalledShowNumber?{calledShowNumber:s.phoneCalledShowNumber}:{}),ttsCode:s.phoneTemplateCode,ttsParam:params(s.phoneTemplateParams,employee,businessDate),playTimes:1}),{autoretry:false,maxAttempts:1,readTimeout:15000,connectTimeout:10000});
      if(result.body?.code!=='OK')throw cleanError('电话服务拒绝了请求');
      return {receiptId:result.body.callId||result.body.requestId};
    }
  };
}
