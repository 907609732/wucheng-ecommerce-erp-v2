import fs from 'node:fs';
import path from 'node:path';
import {WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {assertAgentRegistry} from './isolation.mjs';
import {hostError} from './common.mjs';

const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
/** Read only. Never stop a module or replace binaries beneath a living process. */
export function betaProcessesRunning(paths){
  const registry=assertAgentRegistry(paths);
  for(const id of WORKBENCH_MODULES){const config=registry[id];for(const name of ['.integration-start.lock',id==='warehouse'?'.integration-runtime-cloud.json':'.integration-runtime.json']){
    const file=path.join(config.dataDir,name);let text;try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw hostError('BETA_PROCESS_RECORD_INVALID','测试组件运行记录无效',409);text=fs.readFileSync(file,'utf8').trim();}catch(error){if(error.code==='ENOENT')continue;throw error;}
    let record;try{record=/^\d+$/.test(text)?{ownerPid:Number(text)}:JSON.parse(text);if(!record||typeof record!=='object'||Array.isArray(record))throw Error();}catch{throw hostError('BETA_PROCESS_RECORD_INVALID','测试组件运行记录无法读取，暂不能替换程序',409);}
    if([record.pid,record.childPid,record.ownerPid].some(alive))return true;
  }}return false;
}
