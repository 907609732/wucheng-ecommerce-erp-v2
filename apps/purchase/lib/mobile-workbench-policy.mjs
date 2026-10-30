import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validatePolicy} from './workbench-policy.mjs';
import {verifyWorkbenchActor} from './workbench-actor.mjs';
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const authWrites=new Set(['/api/mobile/pair','/api/mobile/username','/api/mobile/logout']);
export const mobileBusinessWrite=q=>!['GET','HEAD','OPTIONS'].includes(q.method)&&!authWrites.has(q.path);
export function mobilePolicyPath(explicit){if(explicit!==undefined)return explicit;if(process.env.LINGTU_WORKBENCH_POLICY_FILE)return process.env.LINGTU_WORKBENCH_POLICY_FILE;const standard=path.join(process.env.APPDATA||os.homedir(),'wucheng-ecommerce-erp-v2','workbench-server','access-policy.json');return fs.existsSync(standard)?standard:'';}
// Tailscale Serve is the only trusted identity injector on the existing 443
// phone endpoint. A configured policy failing to load never falls back to local.
export function mobileWorkbenchIdentity(q,{policyFile,origin,managed=process.env.LINGTU_AGENT_MANAGED==='1',workbenchKey}){
 if(managed){
  if(!loopback.has(q.socket.remoteAddress)||! /^(?:127\.0\.0\.1|localhost):\d+$/.test(q.headers.host||''))throw Object.assign(Error('Beta手机入口只接受共享工作台签名转发'),{status:403});
  let actor;try{actor=verifyWorkbenchActor(q.headers,workbenchKey,{module:'purchase',method:q.method,path:q.originalUrl});}catch{throw Object.assign(Error('请从已登录的共享工作台打开采购手机页'),{status:401});}
  if(Object.hasOwn(actor,'localDesktop')&&(actor.localDesktop!==true||!actor.id.startsWith('windows:')||actor.uiOrigin!=='http://'+q.headers.host||q.headers.origin&&q.headers.origin!==actor.uiOrigin))throw Object.assign(Error('本机手机页身份或来源不匹配'),{status:403});
  if(actor.channel!=='ui')throw Object.assign(Error('手机交互必须使用真实工作台页面会话'),{status:403});
  // Role/module fields remain the signed protocol envelope, not an access policy.
  return {...actor,role:'admin',modules:['warehouse','purchase','sales','overview','exporter'],canRunTasks:true,entry:'agent-mobile-gateway'};
 }

 if(!policyFile)return null;
 if(!loopback.has(q.socket.remoteAddress)||q.headers.host!==new URL(origin).host)throw Object.assign(Error('手机身份只接受本机 Tailscale Serve 转发'),{status:403});
 const raw=q.headers['tailscale-user-login'];if(typeof raw!=='string'||!raw.trim()||raw.length>254||/[\s,\r\n]/.test(raw))throw Object.assign(Error('缺少可信的 Tailscale 用户身份'),{status:403});
 let policy;try{policy=validatePolicy(JSON.parse(fs.readFileSync(policyFile,'utf8')));}catch(e){throw Object.assign(Error('工作台访问策略不可用，请在主机检查配置'),{status:503});}
 const login=raw.trim().toLowerCase(),grant=policy.users[login];if(!grant?.enabled||!grant.modules.includes('purchase'))throw Object.assign(Error('当前 Tailscale 用户尚未获准访问采购台'),{status:403});
 if(grant.role==='viewer'&&mobileBusinessWrite(q))throw Object.assign(Error('当前账号只允许查看采购数据'),{status:403});
 return {id:'tailscale:'+login,login,role:grant.role,modules:grant.modules,canRunTasks:grant.canRunTasks,channel:'ui',module:'purchase',entry:'mobile443'};
}
