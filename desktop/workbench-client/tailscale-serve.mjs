import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const exe=()=>path.join(process.env.ProgramFiles||'C:/Program Files','Tailscale','tailscale.exe');
const invoke=args=>execFileSync(exe(),args,{encoding:'utf8',windowsHide:true,timeout:30000});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function prepareServe({origin,backupRoot,run=invoke}){
  const host=new URL(origin).hostname,before=JSON.parse(run(['serve','status','--json'])),key=host+':8443',entry=before.Web?.[key];
  if(before.AllowFunnel?.[key])throw Error('8443 已启用公网 Funnel，已阻止接入；请先在主机核对该端口');
  if(entry&&!same(entry,{Handlers:{'/':{Proxy:'http://127.0.0.1:17330'}}}))throw Error('8443 已被其他 Tailscale 服务使用，不能覆盖');
  fs.mkdirSync(backupRoot,{recursive:true});
  const file=path.join(backupRoot,'serve-before-'+new Date().toISOString().replaceAll(':','-')+'.json');
  fs.writeFileSync(file,JSON.stringify(before,null,2),{mode:0o600});
  return {before,file,host,key,alreadyEnabled:!!entry,difference:{add:entry?[]:['HTTPS 8443 → http://127.0.0.1:17330'],preserve:Object.keys(before.Web||{}),funnel:false}};
}
export function enableServe(options){
  const run=options.run||invoke,plan=prepareServe({...options,run});
  if(!plan.alreadyEnabled)run(['serve','--bg','--https=8443','http://127.0.0.1:17330']);
  const after=JSON.parse(run(['serve','status','--json']));
  if(after.Web?.[plan.key]?.Handlers?.['/']?.Proxy!=='http://127.0.0.1:17330'||after.TCP?.['8443']?.HTTPS!==true||after.AllowFunnel?.[plan.key])throw Error('Tailscale 私网 HTTPS 配置校验失败，请在主机检查网络差异文件');
  for(const [key,value]of Object.entries(plan.before.Web||{}))if(!same(after.Web?.[key],value))throw Error('其他 Tailscale 网页入口发生变化，已停止后续切换');
  for(const [key,value]of Object.entries(plan.before.TCP||{}))if(!same(after.TCP?.[key],value))throw Error('其他 Tailscale 端口发生变化，已停止后续切换');
  return {...plan,after};
}
export function rollbackServe({origin,beforeFile,run=invoke}){
  const before=JSON.parse(fs.readFileSync(beforeFile,'utf8')),host=new URL(origin).hostname,key=host+':8443',now=JSON.parse(run(['serve','status','--json']));
  if(before.Web?.[key])return {changed:false,reason:'原配置已经有 8443，保留原入口'};
  if(now.Web?.[key]?.Handlers?.['/']?.Proxy!=='http://127.0.0.1:17330')throw Error('8443 已发生其他修改，不能自动撤销');
  run(['serve','--https=8443','off']);return {changed:true,remaining:JSON.parse(run(['serve','status','--json']))};
}
