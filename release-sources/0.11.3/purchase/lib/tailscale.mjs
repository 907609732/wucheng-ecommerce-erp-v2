import fs from 'node:fs';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
export function describeTailscale(status,serve,origin){
 const state=status.BackendState||'Unknown',connected=state==='Running'&&status.Self?.Online===true;
 const funnel=Object.values(serve?.AllowFunnel||{}).some(Boolean);
 let host='';try{host=new URL(origin).hostname;}catch{}
 const serveReady=!!host&&serve?.TCP?.['443']?.HTTPS===true&&serve?.Web?.[host+':443']?.Handlers?.['/']?.Proxy==='http://127.0.0.1:17869'&&!funnel;
 const messages={Stopped:'Tailscale 未连接，请打开客户端并点击连接',NeedsLogin:'Tailscale 需要登录，请打开客户端完成登录',NeedsMachineAuth:'Tailscale 设备等待账户审批',Starting:'Tailscale 正在连接，请稍后重新检测',NoState:'Tailscale 正在启动，请稍后重新检测'};
 let message=!connected?(messages[state]||'Tailscale 尚未连接，请检查客户端和电脑网络'):funnel?'检测到公网 Funnel，请在客户端关闭后使用私有入口':!serveReady?'Tailscale 已连接，采购私有 HTTPS 入口未配置或地址不匹配':'Tailscale 已连接，采购私有 HTTPS 入口正常';
 if(state==='Running'&&!connected)message='Tailscale 暂时离线，请检查电脑网络';
 return {state,connected,serveReady,funnel,message};
}
export function createTailscale({platform=process.platform,exists=fs.existsSync,execute=exec,launch,now=Date.now}={}){
 const dir=path.join(process.env.ProgramW6432||process.env.ProgramFiles||'C:\\Program Files','Tailscale');
 const cli=path.join(dir,'tailscale.exe'),gui=path.join(dir,'tailscale-ipn.exe');
 let cached=null,pending=null,lastOpen=-Infinity;
 const detect=async origin=>{
  const canOpen=platform==='win32'&&exists(gui);
  if(platform!=='win32'||!exists(cli))return {state:'NotInstalled',connected:false,serveReady:false,canOpen,message:'未检测到 Windows Tailscale 客户端，请先安装'};
  const options={timeout:5000,maxBuffer:4*1024*1024,windowsHide:true};
  let status;try{const result=await execute(cli,['status','--json'],options);status=JSON.parse(result.stdout);}catch(error){
   try{status=JSON.parse(error.stdout);}catch{return {state:'Unavailable',connected:false,serveReady:false,canOpen,message:'无法读取 Tailscale 状态，请打开客户端检查后台服务'};}
  }
  let serve=null;try{serve=JSON.parse((await execute(cli,['serve','status','--json'],options)).stdout);}catch{}
  return {...describeTailscale(status,serve,origin),canOpen};
 };
 return {
  async status(origin){
   if(cached?.origin===origin&&now()-cached.at<10000)return cached.value;
   if(pending)return pending;
   pending=detect(origin).then(value=>{cached={origin,at:now(),value};return value;}).finally(()=>pending=null);
   return pending;
  },
  async open(){
   if(platform!=='win32'||!exists(gui))throw Error('未找到 Tailscale 客户端，请先安装');
   if(now()-lastOpen<5000)return {ok:true,message:'已请求打开 Tailscale，请查看屏幕右下角托盘'};
   if(launch)await launch(gui);else await new Promise((resolve,reject)=>{const child=spawn(gui,[],{shell:false,windowsHide:true,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
   lastOpen=now();cached=null;
   return {ok:true,message:'已请求打开 Tailscale，请查看屏幕右下角托盘；未连接时请点击连接'};
  }
 };
}
