import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import log from './vendor/electron-log/node.js';
import {sanitizeDiagnosticText,diagnosticLogLevel} from '../shared/diagnostics.mjs';

export const LOG_SOURCES={workbench:'工作台',warehouse:'云仓同步',purchase:'采购台',sales:'销售台',overview:'经营总览',exporter:'订单导出台',gateway:'业务网关',network:'私网连接'};
export function safeLogText(value){
 const raw=String(value??'').replace(/\x1b\[[0-9;]*m/g,'').replace(/((?:cookie|set-cookie|authorization)\s*[:=]\s*)[^\r\n]*/gi,'$1[REDACTED]').replace(/([\"']?(?:password|passwd|secret|token|access_token|refresh_token|api[_-]?key|client[_-]?secret|sessionid|account|username|phone|address)[\"']?\s*[:=]\s*)(\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1[REDACTED]');
 return sanitizeDiagnosticText(raw)
  .replace(/(?:https?|wss?|socks5?|ftp):\/\/[^\s"'<>]+/gi,value=>{try{return new URL(value).origin+'/[路径已隐藏]';}catch{return '[链接已隐藏]';}})
  .replace(/(["']?(?:cookie|set-cookie|password|passwd|secret|token|access_token|refresh_token|authorization|api[_-]?key|client[_-]?secret|sessionid|account|username|phone|address)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1[REDACTED]')
  .replace(/\b[A-Z]:[\\/][^\r\n"'<>]*/gi,'[本机路径已隐藏]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[邮箱已隐藏]')
  .replace(/\b1[3-9]\d{9}\b/g,'[手机号已隐藏]').slice(0,6000);
}
async function safeTail(file,maxBytes=256*1024){
 // Fixed application-owned filenames only; reject links even on an ancestor.
 let cursor=path.resolve(file);
 for(;;){try{if((await fs.lstat(cursor)).isSymbolicLink())throw Error('日志路径包含链接，已拒绝读取');}catch(e){if(e.code!=='ENOENT')throw e;}
  const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
 let handle;
 try{handle=await fs.open(file,'r');const stat=await handle.stat();if(!stat.isFile())throw Error('日志不是普通文件');const offset=Math.max(0,stat.size-maxBytes),buffer=Buffer.alloc(Math.min(stat.size,maxBytes));const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);let text=buffer.subarray(0,bytesRead).toString('utf8');if(offset){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}return {text,truncated:offset>0,modifiedAt:stat.mtimeMs};}
 catch(e){if(e.code==='ENOENT')return {text:'',missing:true};throw e;}finally{await handle?.close();}
}
export function createDiagnostics({profile,services,mode=()=> 'standalone',version,maxBytes=4*1024*1024}){
 const directory=path.join(profile,'launcher','logs'),sessionId=randomUUID();
 log.transports.console.writeFn=()=>{};
 const logger=log.create({logId:'workbench-'+sessionId});let storageError='';
 for(const transport of Object.values(logger.transports))if(transport)transport.level=false;
 logger.transports.console.writeFn=()=>{};
 const file=logger.transports.file;file.resolvePathFn=()=>path.join(directory,'workbench.log');file.maxSize=maxBytes;file.sync=true;file.level='info';
 let observedFile=false;
 function write(level,source,event){try{if(!observedFile){const target=file.getFile();if(target.isNull?.())storageError='日志写入失败，请检查磁盘空间及目录权限';target.on('error',()=>{storageError='日志写入失败，请检查磁盘空间及目录权限';});observedFile=true;}const text=safeLogText(event);logger[['info','warn','error'].includes(level)?level:'info']('['+(Object.hasOwn(LOG_SOURCES,source)?source:'workbench')+'] ['+sessionId.slice(0,8)+'] '+text);}catch{storageError='日志暂时无法写入';}}
 function paths(){
  const sources={workbench:[path.join(directory,'workbench.old.log'),path.join(directory,'workbench.log')],network:[]};
  if(mode()!=='client'){
   for(const id of ['warehouse','purchase','sales','overview','exporter']){const c=services.config(id);sources[id]=id==='warehouse'?[path.join(c.dataDir,'workspace/logs/desktop.log')]:id==='exporter'?[path.join(c.authProfileDir||c.dataDir,'logs/main.old.log'),path.join(c.authProfileDir||c.dataDir,'logs/main.log')]:[path.join(c.dataDir,'integration-service.log')];}
   sources.gateway=[path.join(profile,'workbench-server/gateway.log')];
  }
  return sources;
 }
 async function read(options={}){
  const source=options.source||'all',level=options.level||'any';if(source!=='all'&&!Object.hasOwn(LOG_SOURCES,source))throw Error('未知日志模块');if(!['any','error','warning','info'].includes(level))throw Error('未知日志级别');
  const query=String(options.query||'').slice(0,100).toLowerCase(),limit=Math.min(1000,Math.max(1,Number(options.limit)||300));
  const files=paths(),entries=[],issues=[];let truncated=false;
  const selected=source==='all'?Object.keys(files):source==='workbench'?['workbench']:['workbench',...(files[source]?.length?[source]:[])];
  for(const id of selected){if(!files[id])continue;for(const name of files[id]){
   try{const tail=await safeTail(name);truncated ||=!!tail.truncated;
    let lineTime=tail.modifiedAt||0;
    const lines=tail.text.split(/\r?\n/).filter(Boolean);truncated ||=lines.length>2000;
    for(const line of lines.slice(-2000)){
     const text=safeLogText(line),taggedSource=id==='workbench'?text.match(/\[(workbench|warehouse|purchase|sales|overview|exporter|network|gateway)\]/)?.[1]:null,actualSource=taggedSource||id;
     if(source!=='all'&&actualSource!==source)continue;
     const stamp=text.match(/(?:\[|^)(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)/)?.[1];const parsed=stamp?Date.parse(stamp):NaN;lineTime=Number.isFinite(parsed)?parsed:lineTime+0.001;
     const tag=text.match(/\[(error|warn|warning|info)\]/i)?.[1]?.toLowerCase();const row={source:actualSource,level:tag==='warn'?'warning':tag||diagnosticLogLevel(text),text,time:lineTime};if((level==='any'||row.level===level)&&(!query||text.toLowerCase().includes(query)))entries.push(row);
    }
   }catch(error){issues.push({source:id,error:safeLogText(error.message)});}
  }}
  entries.sort((a,b)=>a.time-b.time);
  // Continuation lines retain their preceding timestamp and relative ordering.
  return {entries:entries.slice(-limit),truncated:truncated||entries.length>limit,issues,storageError,mode:mode(),version,checkedAt:new Date().toISOString(),sources:Object.keys(files).map(id=>({id,label:LOG_SOURCES[id]}))};
 }
 async function bundle(){const logs=await read({limit:1000});const states=mode()==='client'?[]:await services.status({includeWarehouse:true});return {format:'lingtu-diagnostics/v1',createdAt:new Date().toISOString(),version,platform:process.platform,arch:process.arch,system:os.release(),electron:process.versions.electron||null,mode:mode(),sessionId,services:states.map(s=>({id:s.extension,status:s.status,version:s.version,busy:!!s.busy,error:safeLogText(s.error||'')})),...logs,notice:'仅包含有界日志与运行状态，不包含账本、附件、Cookie、配置或认证文件。发送前请核对日志中的业务信息。'};}
 return {directory,write,read,bundle,get storageError(){return storageError;}};
}
