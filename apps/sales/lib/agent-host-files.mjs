import fs from 'node:fs';import {createHash} from 'node:crypto';
export const MAX_AGENT_FILE_BYTES=50*1024*1024;
const PART=1024*1024;
const error=(code,message)=>Object.assign(Error(message),{code});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// Called only by trusted host code. The model supplies an attachment ID, never bytes or paths.
export async function stageTaskAttachment({module,attachmentId,ctx,request}){
 if(!ctx?.taskId||typeof ctx.resolveAttachment!=='function')throw error('AGENT_ATTACHMENT_RESOLVER_REQUIRED','缺少当前任务的可信附件解析器');
 if(typeof attachmentId!=='string'||!attachmentId)throw error('AGENT_ATTACHMENT_ID_REQUIRED','请选择当前任务附件');
 const item=await ctx.resolveAttachment(attachmentId);
 if(!item||item.taskId&&item.taskId!==ctx.taskId)throw error('AGENT_ATTACHMENT_SCOPE','附件不属于当前任务');
 const absolute=item.path||item.filePath||item.absolutePath,filename=item.name||item.filename;
 if(typeof absolute!=='string'||typeof filename!=='string')throw error('AGENT_ATTACHMENT_INVALID','可信附件元数据缺少文件位置或名称');
 const source=fs.openSync(absolute,'r');
 try{
  const before=fs.fstatSync(source);if(!before.isFile()||before.size<1||before.size>MAX_AGENT_FILE_BYTES)throw error('AGENT_ATTACHMENT_SIZE','原件必须在1字节至50MiB之间');
  if(item.size!==undefined&&item.size!==before.size)throw error('AGENT_ATTACHMENT_CHANGED','附件大小与任务记录不一致');
  const whole=createHash('sha256'),buffer=Buffer.alloc(PART);for(let offset=0;offset<before.size;){const count=fs.readSync(source,buffer,0,Math.min(PART,before.size-offset),offset);if(!count)throw error('AGENT_ATTACHMENT_CHANGED','附件读取不完整');whole.update(buffer.subarray(0,count));offset+=count;}
  const sha256=whole.digest('hex');if(item.sha256&&item.sha256!==sha256)throw error('AGENT_ATTACHMENT_CHANGED','附件摘要与任务记录不一致');
  const uploadKey=digest(Buffer.from(JSON.stringify({attachmentId,taskId:ctx.taskId,filename,size:before.size,sha256}))),call=(route,body)=>request(module,'/api/integration/v1/agent/files/upload/'+route,{method:'POST',body,ctx,signal:ctx.signal});
  const started=await call('start',{taskId:ctx.taskId,uploadKey,filename,size:before.size,sha256});if(started.state==='completed')return started.file;
  if(started.chunkSize!==PART||!started.uploadId||!Array.isArray(started.received))throw error('AGENT_UPLOAD_PROTOCOL','模块上传协议不兼容');
  const received=new Set(started.received);for(let index=0,offset=0;offset<before.size;index++,offset+=PART){if(received.has(index))continue;const length=Math.min(PART,before.size-offset),bytes=Buffer.alloc(length),read=fs.readSync(source,bytes,0,length,offset);if(read!==length)throw error('AGENT_ATTACHMENT_CHANGED','附件在分片期间变化');await call('part',{taskId:ctx.taskId,uploadId:started.uploadId,index,sha256:digest(bytes),dataBase64:bytes.toString('base64')});}
  const after=fs.fstatSync(source);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw error('AGENT_ATTACHMENT_CHANGED','附件在上传期间变化，请重新核对');
  return (await call('finish',{taskId:ctx.taskId,uploadId:started.uploadId})).file;
 }finally{fs.closeSync(source);}
}

// Resolve every module artifact through the host's real streamed download + registerArtifact bridge.
export async function materializeArtifacts({module,value,ctx,transport}){
 const cache=new Map();
 const visit=async item=>{
  if(Array.isArray(item))return Promise.all(item.map(visit));if(!item||typeof item!=='object')return item;
  if(typeof item.url==='string'&&typeof item.sha256==='string'&&typeof item.filename==='string'&&item.id){
   if(typeof transport?.download!=='function')throw error('AGENT_ARTIFACT_DOWNLOAD_REQUIRED','主机缺少下载并登记任务文件的可信桥接');
   const route=item.url;if(!/^\/api\/integration\/v1\/agent\/files\/[a-f0-9-]+$/.test(route)||!(/^[a-f0-9]{64}$/).test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>MAX_AGENT_FILE_BYTES)throw error('AGENT_ARTIFACT_INVALID','模块下载元数据无效或超过50MiB');
   const key=route+':'+item.sha256;if(!cache.has(key))cache.set(key,Promise.resolve(transport.download(module,route,{ctx,expectedSha256:item.sha256,filename:item.filename,maxBytes:MAX_AGENT_FILE_BYTES})).then(output=>{if(!output||typeof output!=='object'||typeof output.id!=='string'||output.sha256!==item.sha256)throw error('AGENT_ARTIFACT_REGISTRATION_REQUIRED','下载未返回已登记且摘要一致的任务文件');return {...output,filename:output.name||output.filename||item.filename};}));
   return {...await cache.get(key),...(item.type?{type:item.type}:{})};
  }
  return Object.fromEntries(await Promise.all(Object.entries(item).map(async([key,x])=>[key,await visit(x)])));
 };
 return visit(value);
}

// Public model schemas accept managed module file IDs; inline transport schemas stay internal.
export function publicFileSchema(schema){
 const fileId={type:'object',properties:{id:{type:'string',minLength:1,description:'本任务files.stage返回的模块原件ID'}},required:['id'],additionalProperties:false};
 const walk=value=>{if(Array.isArray(value))return value.map(walk);if(!value||typeof value!=='object')return value;
  if(value.properties?.dataBase64||value.oneOf?.some(branch=>branch.properties?.dataBase64||branch.required?.includes('dataBase64'))){const p=value.properties||{};if(p.file){const properties=Object.fromEntries(Object.entries(p).filter(([key])=>!['filename','dataBase64','sha256'].includes(key)).map(([key,x])=>[key,key==='file'?fileId:walk(x)]));return {...value,properties,required:[...new Set([...(value.required||[]).filter(key=>!['filename','dataBase64','sha256'].includes(key)),'file'])],oneOf:undefined};}return fileId;}
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='dataBase64').map(([key,x])=>[key,walk(x)]));};
 return JSON.parse(JSON.stringify(walk(schema)));
}
