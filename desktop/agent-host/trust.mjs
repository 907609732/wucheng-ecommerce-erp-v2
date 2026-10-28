import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostError} from './common.mjs';

export function assertLauncherSender(event,window,files){
  if(!window||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw hostError('UI_SOURCE_DENIED','调用不是来自工作台主界面',403);
  let url,file;try{url=new URL(event.senderFrame.url);file=fileURLToPath(url);}catch{throw hostError('UI_SOURCE_DENIED','工作台页面来源无效',403);}
  const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(url.protocol!=='file:'||url.host||url.search||!files.some(allowed=>same(path.resolve(allowed),path.resolve(file))))throw hostError('UI_SOURCE_DENIED','工作台页面来源不受信任',403);
}
export function agentEnvelope(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['operation','payload'].includes(k))||typeof value.operation!=='string'||!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(value.operation)||value.operation.length>100)throw hostError('AGENT_REQUEST_INVALID','任务接口参数无效');
  const payload=value.payload??{};
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||['actor','trustedUi','approval','confirmed','role','sessionId'].some(k=>Object.hasOwn(payload,k)))throw hostError('IDENTITY_INPUT_DENIED','请求不能自选身份或提供确认凭据',403);
  if(Buffer.byteLength(JSON.stringify(payload))>48*1024*1024)throw hostError('AGENT_INPUT_TOO_LARGE','任务附件或参数过大',413);
  return {operation:value.operation,payload};
}
