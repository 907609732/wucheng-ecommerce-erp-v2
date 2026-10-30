import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const lockName='beta-data-maintenance.lock';
function noLinks(target){let current=path.parse(target).root;for(const part of target.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Beta 维护路径包含链接');}}
export function assertBetaDataNotInMaintenance(paths){
  const root=path.resolve(paths?.root||''),lock=path.join(root,lockName);
  if(!paths?.root||!path.isAbsolute(paths.root))throw Error('Beta 数据目录未绑定');
  noLinks(root);if(fs.existsSync(lock))throw Object.assign(Error('测试账本正在准备或回滚，请等待处理完成'),{code:'BETA_DATA_MAINTENANCE',statusCode:409});
}

// Acquiring is explicit; a crash leaves a fence for manual inspection rather
// than silently reopening partially prepared data to business services.
export function withBetaDataMaintenance(paths,operation){
  const root=path.resolve(paths?.root||''),expected=path.resolve(process.env.LOCALAPPDATA||'','WuchengAgentBeta');
  if(!process.env.LOCALAPPDATA||root!==expected||typeof operation!=='function')throw Error('维护操作仅允许固定 Beta 数据目录');
  noLinks(root);fs.mkdirSync(root,{recursive:true});const lock=path.join(root,lockName),token=crypto.randomUUID();noLinks(lock);
  fs.writeFileSync(lock,JSON.stringify({format:'agent-beta-data-maintenance/v1',token,pid:process.pid,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
  let switching=false;const markSwitching=()=>{switching=true;};
  const release=()=>{noLinks(lock);const record=JSON.parse(fs.readFileSync(lock,'utf8'));if(record.token!==token)throw Error('Beta 维护记录已变化');fs.unlinkSync(lock);};
  try{const result=operation(markSwitching);if(result?.then)throw Error('Beta 维护操作必须同步完成');release();return result;}catch(error){if(!switching)release();throw error;}
}

// Host must use this same exclusive fence around the entire async start, not
// just a one-time preflight check, so maintenance cannot race service startup.
export async function withBetaServiceStartFence(paths,operation){
  const root=path.resolve(paths?.root||''),local=path.resolve(process.env.LOCALAPPDATA||'');
  if(!process.env.LOCALAPPDATA||path.dirname(root)!==local||!/^WuchengAgentBeta(?:-[a-z0-9_-]+)?$/i.test(path.basename(root))||typeof operation!=='function')throw Error('测试服务目录未绑定');
  noLinks(root);fs.mkdirSync(root,{recursive:true});const lock=path.join(root,lockName),token=crypto.randomUUID();noLinks(lock);
  fs.writeFileSync(lock,JSON.stringify({format:'agent-beta-service-start/v1',token,pid:process.pid,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
  try{return await operation();}finally{noLinks(lock);const record=JSON.parse(fs.readFileSync(lock,'utf8'));if(record.token!==token)throw Error('Beta 服务启动记录已变化');fs.unlinkSync(lock);}
}
