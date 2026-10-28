import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validatePolicy} from './workbench-policy.mjs';
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const authWrites=new Set(['/api/mobile/pair','/api/mobile/username','/api/mobile/logout']);
export const mobileBusinessWrite=q=>!['GET','HEAD','OPTIONS'].includes(q.method)&&!authWrites.has(q.path);
export function mobilePolicyPath(explicit){if(explicit!==undefined)return explicit;if(process.env.LINGTU_WORKBENCH_POLICY_FILE)return process.env.LINGTU_WORKBENCH_POLICY_FILE;const standard=path.join(process.env.APPDATA||os.homedir(),'wucheng-ecommerce-erp-v2','workbench-server','access-policy.json');return fs.existsSync(standard)?standard:'';}
// Tailscale Serve is the only trusted identity injector on the existing 443
// phone endpoint. A configured policy failing to load never falls back to local.
export function mobileWorkbenchIdentity(q,{policyFile,origin}){
 if(!policyFile)return null;
 if(!loopback.has(q.socket.remoteAddress)||q.headers.host!==new URL(origin).host)throw Object.assign(Error('手机身份只接受本机 Tailscale Serve 转发'),{status:403});
 const raw=q.headers['tailscale-user-login'];if(typeof raw!=='string'||!raw.trim()||raw.length>254||/[\s,\r\n]/.test(raw))throw Object.assign(Error('缺少可信的 Tailscale 用户身份'),{status:403});
 let policy;try{policy=validatePolicy(JSON.parse(fs.readFileSync(policyFile,'utf8')));}catch(e){throw Object.assign(Error('工作台访问策略不可用，请在主机检查配置'),{status:503});}
 const login=raw.trim().toLowerCase(),grant=policy.users[login];if(!grant?.enabled||!grant.modules.includes('purchase'))throw Object.assign(Error('当前 Tailscale 用户尚未获准访问采购台'),{status:403});
 if(grant.role==='viewer'&&mobileBusinessWrite(q))throw Object.assign(Error('当前账号只允许查看采购数据'),{status:403});
 return {id:'tailscale:'+login,login,role:grant.role,modules:grant.modules,canRunTasks:grant.canRunTasks,channel:'ui',module:'purchase',entry:'mobile443'};
}
