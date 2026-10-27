import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export function tailscaleHost(){
  const exe=path.join(process.env.ProgramFiles||'C:/Program Files','Tailscale','tailscale.exe');
  const status=JSON.parse(execFileSync(exe,['status','--json'],{encoding:'utf8',windowsHide:true,timeout:10000}));
  if(status.BackendState!=='Running'||!status.Self?.DNSName)throw Error('请先在主服务器登录 Tailscale');
  const owner=status.User?.[String(status.Self.UserID)]?.LoginName;
  if(!owner)throw Error('无法确认主服务器当前成员身份');
  return {origin:'https://'+status.Self.DNSName.replace(/\.$/,'')+':8443',owner:owner.toLowerCase()};
}
export async function startGateway({root,entry,node,registryFile,origin,owner}){
  fs.mkdirSync(root,{recursive:true});
  const policyFile=path.join(root,'access-policy.json');
  if(!fs.existsSync(policyFile)){
    if(!owner)throw Error('首次启用需要确认主服务器 Tailscale 管理员身份');
    fs.writeFileSync(policyFile,JSON.stringify({schemaVersion:1,users:{[owner]:{role:'admin',modules:['warehouse','purchase','sales','overview','exporter'],canRunTasks:true,enabled:true}}},null,2),{flag:'wx',mode:0o600});
  }
  async function live(){
    try{const res=await fetch('http://127.0.0.1:17330/api/workbench/v1/health',{signal:AbortSignal.timeout(1500),redirect:'error'});if(!res.ok)return null;return await res.json();}catch{return null;}
  }
  const current=await live();
  if(current){
    const identity=JSON.parse(fs.readFileSync(path.join(root,'identity.json'),'utf8'));
    if(current.serverId!==identity.serverId||current.dataSetId!==identity.dataSetId)throw Error('17330 端口上的网关身份不符');return current;
  }
  if(!node||!fs.existsSync(node)||!fs.existsSync(entry))throw Error('网关运行组件或共享 Node.js 未安装，请在主机安装完整运行包');
  const log=fs.openSync(path.join(root,'gateway.log'),'a'),env={...process.env,LINGTU_REGISTRY_PATH:registryFile,LINGTU_WORKBENCH_POLICY_FILE:policyFile};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(node,[entry,'--store-dir',root,'--origin',origin],{cwd:path.dirname(entry),env,detached:true,stdio:['ignore',log,log],windowsHide:true,shell:false});
  try{await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}finally{fs.closeSync(log);}
  for(let i=0;i<80;i++){await wait(250);const health=await live();if(health)return health;}
  throw Error('网关启动失败，请查看主机网关日志；已有业务入口保持可用');
}
