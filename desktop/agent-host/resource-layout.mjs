import fs from 'node:fs';
import path from 'node:path';

export const AGENT_RESOURCE_FORMAT_V1='agent-beta-resources/v1';
export const AGENT_RESOURCE_FORMAT_V2='agent-beta-resources/v2';

function physical(file,{directory=false}={}){
  // External Node/Python processes cannot execute Electron's virtual ASAR paths.
  if(file.split(path.sep).some(part=>/\.asar$/i.test(part)))throw Error('Agent 外置资源不能位于 ASAR 虚拟路径');
  let current=path.parse(file).root;
  for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    if(fs.lstatSync(current).isSymbolicLink())throw Error('Agent 外置资源路径包含链接或重定向');
  }
  if(path.relative(file,fs.realpathSync.native(file))!=='')throw Error('Agent 外置资源路径被重定向');
  const stat=fs.lstatSync(file);
  if(directory?!stat.isDirectory():!stat.isFile())throw Error('Agent 外置资源类型无效');
}

/** Resolve only the packaged launcher's own physical resource layout. */
export function packagedAgentResources({resourcesPath,launcherDirectory}={}){
  if(typeof resourcesPath!=='string'||!path.isAbsolute(resourcesPath)||typeof launcherDirectory!=='string'||!path.isAbsolute(launcherDirectory))throw Error('Agent 打包资源目录必须使用完整路径');
  const resources=path.resolve(resourcesPath),launcher=path.resolve(launcherDirectory);
  physical(resources,{directory:true});
  const unified=path.join(resources,'agent-runtime'),unifiedLauncher=path.join(unified,'desktop','launcher');
  let resourcesDir,engineResourceDir,layout;
  if(path.relative(unifiedLauncher,launcher)===''){
    physical(launcher,{directory:true});
    resourcesDir=unified;engineResourceDir=path.join(unified,'desktop','agent-runtime');layout=AGENT_RESOURCE_FORMAT_V2;
  }else if(['app','app.asar'].some(name=>path.relative(path.join(resources,name,'desktop','launcher'),launcher)==='')){
    resourcesDir=resources;engineResourceDir=path.join(resources,'workbench-gateway','desktop','agent-runtime');layout=AGENT_RESOURCE_FORMAT_V1;
  }else throw Error('Agent launcher 不属于已登记的打包资源布局');
  physical(engineResourceDir,{directory:true});
  for(const name of ['mcp-entry.mjs','hermes-bootstrap.py'])physical(path.join(engineResourceDir,name));
  return {resourcesDir,engineResourceDir,layout};
}
