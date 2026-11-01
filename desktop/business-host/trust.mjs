import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostError} from './common.mjs';

export function assertLauncherSender(event,window,files){
  if(!window||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw hostError('UI_SOURCE_DENIED','调用不是来自工作台主界面',403);
  let url,file;try{url=new URL(event.senderFrame.url);file=fileURLToPath(url);}catch{throw hostError('UI_SOURCE_DENIED','工作台页面来源无效',403);}
  const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(url.protocol!=='file:'||url.host||url.search||!files.some(allowed=>same(path.resolve(allowed),path.resolve(file))))throw hostError('UI_SOURCE_DENIED','工作台页面来源不受信任',403);
}

export function businessEnvelope(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['operation','payload'].includes(key))||typeof value.operation!=='string'||!/^[a-z][a-z.]{0,79}$/.test(value.operation)||value.payload!==undefined&&(!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload)))throw hostError('BUSINESS_REQUEST_INVALID','业务请求格式无效',400);
 return {operation:value.operation,payload:value.payload||{}};
}
