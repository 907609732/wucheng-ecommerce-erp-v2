import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {atomicJson,hostError} from './common.mjs';
import {agentEnvelope} from './trust.mjs';

const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Keeps DPAPI and model credentials in Electron. Only the authenticated gateway calls this private endpoint. */
export async function startAgentBridge({storeDir,request,maxBytes=80*1024*1024}={}){
  const descriptor=path.join(storeDir,'bridge.json'),key=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');
    try{
      if(!loopback(req.socket.remoteAddress)||req.method!=='POST'||req.url!=='/request'||!equal(req.headers.authorization,'Bearer '+key))throw hostError('BRIDGE_DENIED','任务主机连接未授权',403);
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw hostError('AGENT_INPUT_TOO_LARGE','请求超过允许大小',413);chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw hostError('AGENT_REQUEST_INVALID','任务请求格式无效');}
      const envelope=agentEnvelope(body.request),actor=body.actor;
      if(typeof actor?.id!=='string'||!actor.id.startsWith('tailscale:')||!['ui','mcp','cli'].includes(actor.channel))throw hostError('BRIDGE_ACTOR_DENIED','私网请求必须绑定真实成员',403);
      const result=await request(envelope.operation,envelope.payload,{actor:{id:actor.id,channel:actor.channel,sessionId:actor.sessionId},trustedUi:body.trustedUi===true&&actor.channel==='ui'});
      res.end(JSON.stringify(result));
    }catch(error){res.statusCode=error.statusCode||500;res.end(JSON.stringify({ok:false,code:error.code||'HOST_REQUEST_FAILED',error:error.workbenchPublic?error.message:'主机任务未完成，请查看主机状态'}));}
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+server.address().port;
  atomicJson(descriptor,{schemaVersion:1,pid:process.pid,url,key});
  return {url,async close(){try{const current=JSON.parse(fs.readFileSync(descriptor,'utf8'));if(current.key===key)fs.rmSync(descriptor,{force:true});}catch{}server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve));}};
}
export function createAgentBridgeClient({storeDir,fetchImpl=fetch}={}){
  return {async request(operation,payload,{actor,trustedUi=false}={}){
    const envelope=agentEnvelope({operation,payload});
    let descriptor;try{const file=path.join(storeDir,'bridge.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error();descriptor=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw hostError('AGENT_HOST_UNAVAILABLE','请在公司主机启动 Agent 工作台',503);}
    if(descriptor.schemaVersion!==1||!/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.url)||!Number.isInteger(descriptor.pid)||!/^[a-f0-9]{64}$/.test(descriptor.key))throw hostError('AGENT_HOST_UNAVAILABLE','任务主机连接记录无效',503);
    try{process.kill(descriptor.pid,0);}catch{throw hostError('AGENT_HOST_UNAVAILABLE','公司主机任务服务未运行',503);}
    let response;try{response=await fetchImpl(descriptor.url+'/request',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+descriptor.key,'content-type':'application/json'},body:JSON.stringify({request:envelope,actor:{id:actor.id,sessionId:actor.sessionId,channel:actor.channel},trustedUi}),signal:AbortSignal.timeout(125000)});}catch{throw hostError('AGENT_HOST_UNAVAILABLE','公司主机任务服务连接中断，请稍后核对任务结果',503);}
    const result=await response.json();if(!response.ok||result?.ok===false)throw hostError(result.code||'HOST_REQUEST_FAILED',result.error||'任务操作未完成',response.status);return result;
  }};
}
