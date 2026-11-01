import nodeFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setImmediate as yieldToHost} from 'node:timers/promises';
// Resource manifests describe physical files, including the ASAR containers.
// Electron's normal fs intentionally exposes those containers as directories.
const fs=process.versions.electron?process.getBuiltinModule('original-fs'):nodeFs;
import {AGENT_RESOURCE_FORMAT_V2} from './resource-layout.mjs';

export const activationCancelled=()=>Object.assign(Error('已取消准备工作台'),{name:'AbortError',code:'BETA_ACTIVATION_CANCELLED'});
export function createActivationResourceOperation(resourcesDir,{signal,onProgress,batchSize=128,verifiedCache=null}={}){
 const root=path.resolve(resourcesDir),ancestors=new Set(),buffer=Buffer.allocUnsafe(1024*1024);
 const metrics={ancestorChecks:0,canonicalFileChecks:0,fileLstatChecks:0,hashes:0,cachedHashes:0,bufferAllocations:1,yields:0};let batch=0;
 const checkCancelled=()=>{if(signal?.aborted)throw activationCancelled();};
 function canonicalFile(file){
  checkCancelled();file=path.resolve(file);metrics.canonicalFileChecks++;
  if(path.relative(file,fs.realpathSync.native(file))!=='')throw Error('Beta 资源路径被重定向');
  metrics.fileLstatChecks++;const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||!stat.isFile())throw Error('Beta 资源不是普通文件或包含链接');return file;
 }
 function sourceFile(file){
  file=path.resolve(file);const rel=path.relative(root,file);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Beta 资源路径无效');
  let current=path.parse(file).root;
  for(const part of path.dirname(file).slice(current.length).split(path.sep).filter(Boolean)){
   current=path.join(current,part);if(ancestors.has(current))continue;
   const stat=fs.lstatSync(current);metrics.ancestorChecks++;
   if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Beta 激活路径包含链接');ancestors.add(current);
  }
  // Always re-resolve the complete file, even when its ancestors were seen.
  // Replacing a previously checked ancestor with an inner or outer junction
  // remains detectable on every file; no mtime is trusted across calls.
  return canonicalFile(file);
 }
 function hashChecked(file){
  checkCancelled();
  // Cache only dependency files. Application entrypoints/manifests are always
  // hashed. A cache entry is bound to the physical file and NTFS identity,
  // change time, modification time and size; writes/replacements invalidate it.
  const cacheable=verifiedCache&&file.split(path.sep).includes('node_modules');
  const stamp=cacheable?fs.statSync(file,{bigint:true}):null;
  const identity=stamp?[stamp.dev,stamp.ino,stamp.size,stamp.mtimeNs,stamp.ctimeNs].map(String).join(':'):null;
  const previous=cacheable?verifiedCache[file]:null;
  if(previous?.identity===identity&&/^[a-f0-9]{64}$/.test(previous.sha256||'')){metrics.cachedHashes++;return previous.sha256;}
  const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r');metrics.hashes++;
  try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){checkCancelled();hash.update(buffer.subarray(0,n));}const sha256=hash.digest('hex');if(cacheable)verifiedCache[file]={identity,sha256};return sha256;}finally{fs.closeSync(fd);}
 }
 async function checkpoint(progress,{force=false}={}){
  checkCancelled();if(force||++batch>=batchSize){batch=0;onProgress?.(progress);metrics.yields++;await yieldToHost();checkCancelled();}
 }
 return {metrics,checkCancelled,sourceFile,hashFile:file=>hashChecked(canonicalFile(file)),hashResource:file=>hashChecked(sourceFile(file)),checkpoint};
}

export async function verifyActivationResources(resourcesDir,manifest,options={}){
 const res=path.resolve(resourcesDir),operation=options.operation||createActivationResourceOperation(res,options);
 const entries=Object.entries(manifest.payloadHashes).filter(([rel])=>manifest.format===AGENT_RESOURCE_FORMAT_V2||/^(?:apps\/|vendor\/|workbench-gateway\/)/.test(rel));
 await operation.checkpoint({phase:'verify',processed:0,total:entries.length},{force:true});let processed=0;
 for(const [rel,digest]of entries){
  if(!/^[a-f0-9]{64}$/.test(digest)||rel.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:\x00-\x1f]/.test(rel))throw Error('Beta 资源路径无效');
  if(operation.hashResource(path.resolve(res,...rel.split('/')))!==digest)throw Error('Beta 资源摘要不符: '+rel);
  await operation.checkpoint({phase:'verify',processed:++processed,total:entries.length});
 }
 await operation.checkpoint({phase:'verify',processed,total:entries.length},{force:true});return {...operation.metrics};
}
