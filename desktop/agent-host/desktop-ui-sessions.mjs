import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {signWorkbenchActor} from '../workbench/actor.mjs';
import {hostError} from './common.mjs';

const businessDesks=new Set(['purchase','sales','overview']);
const sameFrame=(left,right)=>!!left&&!!right&&(left===right||Number.isInteger(left.processId)&&left.processId===right.processId&&Number.isInteger(left.routingId)&&left.routingId===right.routingId);
const sameOrigin=(value,origin)=>{try{return new URL(value).origin===origin;}catch{return false;}};
const fingerprint=config=>JSON.stringify([config.root,config.dataDir,config.port,config.version,config.managed,config.allowInitialize]);
const actorHeaders=new Set(['x-workbench-actor','x-workbench-actor-signature','x-workbench-prefix','x-workbench-api-base','x-workbench-channel']);
function cleanHeaders(headers={}){return Object.fromEntries(Object.entries(headers).filter(([name])=>!actorHeaders.has(name.toLowerCase())));}
const header=(headers,key)=>Object.entries(headers).find(([name])=>name.toLowerCase()===key)?.[1];
function actorKey(config){
  const file=path.join(config.dataDir,'.workbench-key'),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw hostError('DESKTOP_UI_KEY_INVALID','业务页面身份组件无效',503);
  const key=fs.readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(key))throw hostError('DESKTOP_UI_KEY_INVALID','业务页面身份组件无效',503);
  return key;
}

/** Reuse the existing signed business actor protocol; only owned native views can obtain a proof. */
export function createDesktopUiSessions({services,resolveActor,assertRequestAllowed=()=>{},onError=()=>{}}={}){
  if(!services||typeof resolveActor!=='function')throw TypeError('services and resolveActor are required');
  const sessions=new WeakMap();
  function attach({id,view,cap}){
    if(!businessDesks.has(id)||!view?.webContents)throw hostError('DESKTOP_UI_MODULE_INVALID','此模块不支持本机业务视图');
    const config=services.config(id),url=new URL(cap?.url);
    if(config.managed!==true||config.allowInitialize!==false||config.maintenance||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||Number(url.port)!==config.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw hostError('DESKTOP_UI_ORIGIN_INVALID','业务页面未绑定当前测试模块',403);
    const origin=url.origin,contents=view.webContents,target=contents.session;
    let state=sessions.get(target);
    if(!state){
      state={views:new Map(),origins:new Set()};sessions.set(target,state);
      target.webRequest.onBeforeSendHeaders((details,callback)=>{
        const headers=cleanHeaders(details.requestHeaders),entry=state.views.get(details.webContentsId);
        let request;try{request=new URL(details.url);}catch{callback({cancel:true});return;}
        if(!entry||request.origin!==entry.origin){callback({...(state.origins.has(request.origin)?{cancel:true}:{}),requestHeaders:headers});return;}
        try{
          assertRequestAllowed();
          const current=services.config(entry.id),actor=resolveActor();
          if(fingerprint(current)!==entry.fingerprint||current.maintenance)throw hostError('DESKTOP_UI_CONNECTION_CHANGED','业务连接已变化，请重新打开工作台',409);
          if(!actor?.id?.startsWith('windows:')||actor.enabled===false||actor.channel!=='ui')throw hostError('AUTHENTICATED_UI_REQUIRED','请使用真实 Windows 身份打开公司工作台',403);
          const wc=entry.contents;if(wc.isDestroyed())throw hostError('DESKTOP_UI_FRAME_DENIED','业务页面已关闭',403);const main=wc.mainFrame;
          const frame=details.frame||(details.resourceType==='mainFrame'?main:null);
          if(!sameFrame(frame?.top||frame,main)||!sameFrame(frame,main)&&!sameOrigin(frame?.url,entry.origin))throw hostError('DESKTOP_UI_FRAME_DENIED','业务请求不是来自当前页面',403);
          const originHeader=header(headers,'origin');
          if(details.initiatorOrigin&&details.initiatorOrigin!==entry.origin||originHeader&&originHeader!==entry.origin||header(headers,'sec-fetch-site')==='cross-site')throw hostError('DESKTOP_UI_ORIGIN_INVALID','业务请求来源不符',403);
          if(details.resourceType!=='mainFrame'&&!sameOrigin(main.url,entry.origin))throw hostError('DESKTOP_UI_FRAME_DENIED','业务页面来源已变化',403);
          const issuedAt=Date.now(),proof=signWorkbenchActor({...actor,v:1,module:entry.id,sessionId:actor.sessionId,requestId:randomUUID(),issuedAt,expiresAt:issuedAt+30000,method:details.method,path:request.pathname+request.search,localDesktop:true,uiOrigin:entry.origin},actorKey(current));
          callback({requestHeaders:{...headers,...proof,'X-Workbench-Channel':'ui'}});
        }catch(error){try{onError(error);}catch{}callback({cancel:true});}
      });
    }
    state.origins.add(origin);state.views.set(contents.id,{id,origin,contents,fingerprint:fingerprint(config)});
    contents.once('destroyed',()=>state.views.delete(contents.id));
    return {module:id,origin};
  }
  return {attach};
}
