import WebSocket from 'ws';

const isolationError=reason=>Object.assign(Error('BROWSER_ISOLATION_FAILED: 当前采集页未能安全停止，已暂停共享浏览器采集。'+(reason?' '+reason:'')),{code:'BROWSER_ISOLATION_FAILED'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// CDP is reachable only on the launcher-provided loopback endpoint. Retain the
// browser websocket UUID, so cleanup cannot target a replacement on the port.
function validSocket(value,port){try{const u=new URL(value);return u.protocol==='ws:'&&u.hostname==='127.0.0.1'&&Number(u.port)===port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(u.pathname);}catch{return false;}}
async function cdp(socketUrl,action,timeout=5000){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(socketUrl,{maxPayload:1024*1024});let sequence=0,done=false;
  const pending=new Map(),timer=setTimeout(()=>finish(Error('CDP 操作等待超时')),timeout);
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);for(const p of pending.values())p.reject(error||Error('CDP 已结束'));pending.clear();ws.terminate();error?reject(error):resolve(value);}
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}),error=>{if(error){pending.delete(id);reject(error);}});});
  ws.once('open',()=>Promise.resolve().then(()=>action(send)).then(value=>finish(null,value),finish));
  ws.on('message',raw=>{let value;try{value=JSON.parse(raw.toString());}catch{return finish(Error('CDP 响应无效'));}const p=pending.get(value.id);if(!p)return;pending.delete(value.id);value.error?p.reject(Error('CDP '+value.error.message)):p.resolve(value.result);});
  ws.once('error',finish);ws.once('close',()=>finish(Error('CDP 连接已关闭')));
 });
}
export async function createOwnedTarget(endpoint){
 const match=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(endpoint||'');
 if(!match||Number(match[1])>65535)throw Error('NAS 浏览器 CDP 地址必须指向本机回环端口');
 const response=await fetch(endpoint.replace(/\/$/,'')+'/json/version',{signal:AbortSignal.timeout(5000)}),version=await response.json();
 if(!response.ok||!validSocket(version.webSocketDebuggerUrl,Number(match[1])))throw Error('NAS 浏览器身份无效');
 const socketUrl=version.webSocketDebuggerUrl;
 try {
  const {targetId}=await cdp(socketUrl,send=>send('Target.createTarget',{url:'about:blank',background:true}));
  if(typeof targetId!=='string'||!targetId)throw Error('未返回采集页身份');
  return {targetId,socketUrl};
 } catch(error){throw isolationError('创建采集页的结果不明：'+error.message);}
}
export async function closeOwnedTarget(target){
 if(!target)return;
 try {
  await cdp(target.socketUrl,async send=>{
   const exists=async()=>{const {targetInfos}=await send('Target.getTargets');if(!Array.isArray(targetInfos))throw Error('目标列表无效');return targetInfos.some(info=>info.targetId===target.targetId);};
   if(!await exists())return;
   const result=await send('Target.closeTarget',{targetId:target.targetId});if(result.success!==true)throw Error('采集页拒绝关闭');
   const until=Date.now()+3500;while(await exists()){if(Date.now()>=until)throw Error('采集页仍未关闭');await delay(25);}
  });
 }catch(error){throw isolationError(error.message);}
}
export function ownedOperationCode(operation,arg,targetId){
 return `async (page) => { const context=page.context(); let ownedPage; for (const candidate of context.pages()) { if(candidate.isClosed())continue; let session; try { session=await context.newCDPSession(candidate); const info=await session.send('Target.getTargetInfo'); if(info.targetInfo.targetId===${JSON.stringify(targetId)})ownedPage=candidate; } catch {} finally { await session?.detach().catch(()=>{}); } if(ownedPage)break; } if(!ownedPage||ownedPage.isClosed())throw Error('BROWSER_PAGE_CLOSED:当前采集页已关闭，请重新连接；已下载文件保留'); page=ownedPage; return await (${operation.toString()})(page, ${JSON.stringify(arg)}); }`;
}

// MCP SDK close() can return just after SIGKILL. Observe the transport's public
// onclose callback, installed before Client.connect chains its own callback.
export function observeTransport(transport){
 let started=false,closed=false,resolveClose;
 const closedPromise=new Promise(resolve=>{resolveClose=resolve;}),previous=transport.onclose,start=transport.start.bind(transport);
 transport.onclose=()=>{closed=true;resolveClose();previous?.();};
 transport.start=async()=>{await start();started=true;};
 return {async close(client){
  let closeError;try{await client?.close();await transport.close();}catch(error){closeError=error;}
  if(started&&!closed){let timer;await Promise.race([closedPromise,new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);clearTimeout(timer);}
  if(started&&!closed)throw isolationError('采集助手进程尚未退出');
  if(closeError&&!closed)throw isolationError(closeError.message);
 }};
}
export {isolationError};
