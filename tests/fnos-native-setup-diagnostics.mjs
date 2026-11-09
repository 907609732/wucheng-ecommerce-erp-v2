import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const errorCode=value=>typeof value==='string'&&(Object.hasOwn(os.constants.errno,value)||/^(?:ERR|SQLITE)_[A-Z0-9_]{1,64}$/.test(value));
function errorTail(file){
 const fd=fs.openSync(file,'r');let lines;
 try{
  const size=fs.fstatSync(fd).size,bytes=Buffer.alloc(Math.min(size,8192));
  fs.readSync(fd,bytes,0,bytes.length,Math.max(0,size-bytes.length));
  lines=bytes.toString('utf8').split(/\r?\n/);if(size>bytes.length)lines.shift();
 }finally{fs.closeSync(fd);}
 // Emit codes and stack locations only, never arbitrary messages, source lines,
 // headers or objects that could contain a token or authorization value.
 const safe=lines.flatMap(line=>{
  // purchase's listener intentionally prints this fixed message without a code.
  if(line.trim()==='端口已占用，请打开现有灵兔采购台。')return ['EADDRINUSE'];
  const structured=/^\s*(?:[A-Za-z]*Error(?:\s+\[[^\]]+\])?:|code:)/.test(line);
  const codes=(line.match(/\b(?:(?:ERR|SQLITE)_[A-Z0-9_]+|E[A-Z]+)\b/g)||[]).filter(code=>Object.hasOwn(os.constants.errno,code)||structured&&errorCode(code));
  if(codes.length)return [...new Set(codes)];
  return /^\s+at (?:async )?(?:[\w.$<>]+\s+\()?(?:file:\/\/\/|node:|[A-Za-z]:\\|\/)[^?\r\n]*:\d+:\d+\)?$/.test(line)?[line]:[];
 });
 while(Buffer.byteLength(safe.join('\n'))>8192)safe.shift();
 return safe.join('\n')||'[no error code or stack captured]';
}
export function captureNativeSetupFailure(t,dataRoot){
 const remove=fs.rmSync,prefix=path.resolve(dataRoot)+'.staging-';
 t.mock.method(fs,'rmSync',function(target,...args){
  try{
   if(typeof target==='string'&&target.startsWith(prefix)&&uuid.test(target.slice(prefix.length))){
    let registry={};try{registry=JSON.parse(fs.readFileSync(path.join(target,'state/web-registry.json'),'utf8'));}catch{}
    for(const module of ['purchase','sales','overview']){
     const metadata={module};for(const key of ['port','mobilePort'])if(Number.isInteger(registry[module]?.[key]))metadata[key]=registry[module][key];
     let evidence;try{evidence=errorTail(path.join(target,'data',module,'integration-service.log'));}catch(error){evidence=errorCode(error.code)?error.code:'[log unavailable]';}
     console.error('[native setup failure]',JSON.stringify(metadata),evidence);
    }
   }
  }catch{} // Diagnostics must never replace the original cleanup result/error.
  return Reflect.apply(remove,this,[target,...args]);
 });
}
