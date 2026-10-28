import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const exe=()=>path.join(process.env.ProgramFiles||'C:/Program Files','Tailscale','tailscale.exe');
const invoke=args=>execFileSync(exe(),args,{encoding:'utf8',windowsHide:true,timeout:30000});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function prepareServe({origin,backupRoot,run=invoke,httpsPort=8443,targetPort=17330}){
  if(![httpsPort,targetPort].every(n=>Number.isInteger(n)&&n>=1024&&n<=65535))throw Error('私网端口配置无效');
  const url=new URL(origin);if(url.protocol!=='https:'||Number(url.port||443)!==httpsPort)throw Error('私网地址与 HTTPS 端口不一致');
  const host=url.hostname,before=JSON.parse(run(['serve','status','--json'])),key=host+':'+httpsPort,entry=before.Web?.[key],target='http://127.0.0.1:'+targetPort;
  if(before.AllowFunnel?.[key])throw Error(httpsPort+' 已启用公网 Funnel，已阻止接入；请先在主机核对该端口');
  if(entry&&!same(entry,{Handlers:{'/':{Proxy:target}}}))throw Error(httpsPort+' 已被其他 Tailscale 服务使用，不能覆盖');
  fs.mkdirSync(backupRoot,{recursive:true});
  const file=path.join(backupRoot,'serve-before-'+new Date().toISOString().replaceAll(':','-')+'.json');
  fs.writeFileSync(file,JSON.stringify(before,null,2),{mode:0o600});
  return {before,file,host,key,httpsPort,targetPort,target,alreadyEnabled:!!entry,difference:{add:entry?[]:['HTTPS '+httpsPort+' → '+target],preserve:Object.keys(before.Web||{}),funnel:false}};
}
export function enableServe(options){
  const run=options.run||invoke,plan=prepareServe({...options,run});
  if(!plan.alreadyEnabled)run(['serve','--bg','--https='+plan.httpsPort,plan.target]);
  const after=JSON.parse(run(['serve','status','--json']));
  if(after.Web?.[plan.key]?.Handlers?.['/']?.Proxy!==plan.target||after.TCP?.[String(plan.httpsPort)]?.HTTPS!==true||after.AllowFunnel?.[plan.key])throw Error('Tailscale 私网 HTTPS 配置校验失败，请在主机检查网络差异文件');
  for(const [key,value]of Object.entries(plan.before.Web||{}))if(!same(after.Web?.[key],value))throw Error('其他 Tailscale 网页入口发生变化，已停止后续切换');
  for(const [key,value]of Object.entries(plan.before.TCP||{}))if(!same(after.TCP?.[key],value))throw Error('其他 Tailscale 端口发生变化，已停止后续切换');
  return {...plan,after};
}
export function rollbackServe({origin,beforeFile,run=invoke,httpsPort=8443,targetPort=17330}){
  const before=JSON.parse(fs.readFileSync(beforeFile,'utf8')),host=new URL(origin).hostname,key=host+':'+httpsPort,now=JSON.parse(run(['serve','status','--json']));
  if(before.Web?.[key])return {changed:false,reason:'原配置已经有 '+httpsPort+'，保留原入口'};
  if(now.Web?.[key]?.Handlers?.['/']?.Proxy!=='http://127.0.0.1:'+targetPort)throw Error(httpsPort+' 已发生其他修改，不能自动撤销');
  run(['serve','--https='+httpsPort,'off']);return {changed:true,remaining:JSON.parse(run(['serve','status','--json']))};
}
