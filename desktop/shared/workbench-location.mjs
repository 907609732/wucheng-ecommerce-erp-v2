import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonicalUserDataPath} from './user-data-path.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=message=>Object.assign(Error('工作台数据位置需要核对：'+message),{code:'WORKBENCH_LOCATION_INVALID'});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fail('位置记录或已绑定身份无法读取');}};

export function workbenchLocationFile(home=os.homedir()){
  return path.join(home,'Documents','LingtuWorkbench','workbench-location.json');
}

// Windows may return the logical AppData name for a merged directory even
// though realpath on its existing files resolves to the MSIX physical folder.
// A witness must belong to that same directory identity, not an escaping link.
export function resolvePhysicalDirectory(value,witnesses=[]){
  const stat=fs.statSync(value,{bigint:true});
  if(!stat.isDirectory())throw fail('原配置位置不是目录');
  const candidates=[];
  for(const relative of witnesses){
    if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw fail('目录核对依据无效');
    const file=path.join(value,relative);if(!fs.existsSync(file))continue;
    let physical=fs.realpathSync.native(file);
    for(const _part of relative.split(/[\\/]/).filter(Boolean))physical=path.dirname(physical);
    const target=fs.statSync(physical,{bigint:true});
    if(target.dev!==stat.dev||target.ino!==stat.ino)throw fail('配置目录中的核对文件属于其他位置');
    if(!candidates.some(x=>samePath(x,physical)))candidates.push(physical);
  }
  if(candidates.length>1)throw fail('配置目录包含不同来源的元数据');
  return candidates[0]||fs.realpathSync.native(value);
}

function existingPath(value,kind){
  if(typeof value!=='string'||!value||!path.isAbsolute(value))throw fail('记录必须使用完整的实际路径');
  const resolved=path.resolve(value);
  let stat,physical;
  try{stat=fs.statSync(resolved);physical=kind==='directory'?resolvePhysicalDirectory(resolved,['workbench-server/identity.json','workbench-connection.json','modules/installed.json']):fs.realpathSync.native(resolved);}catch(error){if(error.code==='WORKBENCH_LOCATION_INVALID')throw error;throw fail(kind==='directory'?'原配置目录不存在，已阻止创建空配置':'原注册表不存在');}
  if(kind==='directory'?!stat.isDirectory():!stat.isFile())throw fail('记录指向的文件或目录类型不符');
  // A marker is an explicit physical binding, not another AppData alias whose
  // target can change when launched with or without an MSIX package identity.
  if(!samePath(path.normalize(physical),path.normalize(resolved)))throw fail('记录中的路径已被重定向，请先核对实际位置');
  return physical;
}

function boundIdentity(profile,marker){
  const hasServer=marker.serverId!==undefined,hasData=marker.dataSetId!==undefined;
  const connectionFile=path.join(profile,'workbench-connection.json');
  const connection=fs.existsSync(connectionFile)?readJson(connectionFile):null;
  if(!hasServer&&!hasData){
    if(connection?.pins?.serverId||connection?.pins?.dataSetId||connection?.mode==='server'||fs.existsSync(path.join(profile,'workbench-server','identity.json')))throw fail('已绑定配置的位置记录缺少服务器身份');
    return {};
  }
  if(!uuid.test(marker.serverId||'')||!uuid.test(marker.dataSetId||''))throw fail('服务器身份记录不完整');
  let identity;
  if(connection?.mode==='client')identity=connection.pins;
  else{
    const file=path.join(profile,'workbench-server','identity.json');
    if(!fs.existsSync(file))throw fail('原服务器身份不存在，已阻止生成新身份');
    identity=readJson(file);
  }
  if(identity?.serverId!==marker.serverId||identity?.dataSetId!==marker.dataSetId)throw fail('已绑定服务器或数据集身份发生变化');
  return {serverId:marker.serverId,dataSetId:marker.dataSetId};
}

/** Synchronous and read-only. An explicit profile is an independent namespace. */
export function getWorkbenchLocation(defaultAppData=process.env.APPDATA||os.homedir(),{explicitProfile,registryFile,home=os.homedir()}={}){
  const legacyRegistry=path.join(defaultAppData,'LingtuIntegrations','registry.json');
  if(explicitProfile){
    return {profile:path.resolve(explicitProfile),registryFile:registryFile?path.resolve(registryFile):legacyRegistry,source:'explicit'};
  }
  const markerFile=workbenchLocationFile(home);
  try{fs.statSync(markerFile);}catch(error){
    if(error.code==='ENOENT'||error.code==='ENOTDIR')return {profile:canonicalUserDataPath(defaultAppData),registryFile:registryFile?path.resolve(registryFile):legacyRegistry,source:'legacy'};
    throw fail('位置记录不可访问，已阻止回退到其他配置');
  }
  const marker=readJson(markerFile);
  if(!object(marker)||marker.schemaVersion!==1)throw fail('位置记录版本无效');
  const profile=existingPath(marker.profile,'directory');
  const selectedRegistry=registryFile?path.resolve(registryFile):marker.registryFile;
  const selected=existingPath(selectedRegistry,'file');
  if(!object(readJson(selected)))throw fail('注册表格式无效');
  return {profile,registryFile:selected,source:'marker',markerFile,...boundIdentity(profile,marker)};
}

export function defaultIntegrationRegistryPath(defaultAppData=process.env.APPDATA||os.homedir(),options={}){
  return getWorkbenchLocation(defaultAppData,options).registryFile;
}
