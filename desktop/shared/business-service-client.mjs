import {fork} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const hosts=new Map();
export function spawnBusinessService({registryFile,executable,entry,env,log,id,lockFile,lockToken}){
 const key=path.resolve(registryFile)+'\0'+path.resolve(executable);let host=hosts.get(key);
 if(!host||!host.child.connected){
  const child=fork(new URL('./business-service-host.mjs',import.meta.url),[],{execPath:executable,execArgv:[],env,detached:true,windowsHide:true,stdio:['ignore',log,log,'ipc']});
  host={child,requests:new Map()};hosts.set(key,host);
  child.on('message',message=>{const request=host.requests.get(message?.requestId);if(!request)return;if(message.type==='started')request.emit('spawn');if(message.type==='error')request.emit('error',Error(message.message));if(message.type==='exit'){request.emit('exit',message.code,null);host.requests.delete(message.requestId);}});
  child.on('error',error=>{for(const request of host.requests.values())request.emit('error',error);});
  child.on('exit',(code,signal)=>{for(const request of host.requests.values())request.emit('exit',code,signal);host.requests.clear();if(hosts.get(key)===host)hosts.delete(key);});
  child.unref();child.channel?.unref();
 }
 const requestId=randomUUID(),request=new EventEmitter();request.pid=host.child.pid;request.unref=()=>{};host.requests.set(requestId,request);
 setImmediate(()=>host.child.send({type:'start',requestId,id,entry,env,lockFile,lockToken},error=>{if(error)request.emit('error',error);}));
 return request;
}
