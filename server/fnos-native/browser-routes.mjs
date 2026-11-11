import fs from 'node:fs';
import path from 'node:path';
import httpProxy from '@fastify/http-proxy';
import {nativeBrowserSpecs} from './browsers.mjs';
const publicDir=path.resolve(import.meta.dirname,'../public');
const fail=(statusCode,code,message)=>Object.assign(Error(message),{statusCode,code,workbenchPublic:true});
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.ogg':'audio/ogg','.mp3':'audio/mpeg'};
const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'";
// Exact inline UI bootstrap in upstream noVNC v1.6.0 vnc.html. Keep the
// packaged HTML unchanged and authorize no other inline script or resource.
const novncHtmlCsp=csp.replace("script-src 'self'","script-src 'self' 'sha256-/9PPJp0RDtPobChVxkPiMU+aOqJaic/KxxORSdYVFHE='");
export async function registerNativeBrowserRoutes(app,context,config){
 const browser=config.native?.browser;if(!browser?.enabled)return;
 const specs=nativeBrowserSpecs(config);
 const session=async request=>{const actor=context.resolveActor(request);if(actor.channel!=='ui')throw fail(403,'UI_SESSION_REQUIRED','请在工作台界面打开浏览器');return actor;};
 for(const name of ['native-browser.html','native-browser.js','native-browser.css'])app.get('/web/'+name,{preHandler:session},async(request,reply)=>{
  let bytes=fs.readFileSync(path.join(publicDir,name));if(name.endsWith('.html'))bytes=Buffer.from(bytes.toString('utf8').replaceAll('/web/',context.publicPrefix(request)+'/web/'));
  return reply.header('cache-control','no-store').header('content-security-policy',csp).header('x-content-type-options','nosniff').type(types[path.extname(name)]).send(bytes);
 });
 app.get('/web/novnc/*',{preHandler:session},async(request,reply)=>{
  const raw=request.raw.url.split('?')[0];if(/%|\\/.test(raw)||raw.split('/').some(s=>s==='.'||s==='..'))throw fail(400,'NOVNC_PATH_INVALID','noVNC 资源路径无效');
  const relative=request.params['*'];if(!relative||relative.split('/').some(s=>!s||s.startsWith('.'))||!types[path.extname(relative)])throw fail(404,'NOVNC_ASSET_UNKNOWN','noVNC 资源不存在');
  let file,root;try{root=fs.realpathSync(browser.novncRoot);file=fs.realpathSync(path.resolve(root,relative));}catch{throw fail(404,'NOVNC_ASSET_UNKNOWN','noVNC 资源不存在');}
  if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile())throw fail(404,'NOVNC_ASSET_UNKNOWN','noVNC 资源不存在');
  return reply.header('cache-control','private, no-cache').header('content-security-policy',relative==='vnc.html'?novncHtmlCsp:csp).header('x-content-type-options','nosniff').type(types[path.extname(file)]).send(fs.readFileSync(file));
 });
 for(const spec of Object.values(specs)){
  const prefix='/api/workbench/v1/native-browser/'+spec.id;
  await app.register(httpProxy,{upstream:spec.vncEndpoint,prefix,rewritePrefix:'',routes:['/websockify'],httpMethods:['GET'],websocket:true,
   preHandler:async(request)=>{
    const actor=await session(request);
    const origins=request.raw.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='origin');
    if(origins.length!==1||request.headers.origin!==actor.origin)throw fail(403,'ORIGIN_DENIED','浏览器连接必须来自当前工作台入口');
    if(request.raw.url!==prefix+'/websockify')throw fail(400,'BROWSER_TARGET_DENIED','浏览器只允许固定连接目标');
    if(request.headers.upgrade?.toLowerCase()!=='websocket')throw fail(426,'WEBSOCKET_REQUIRED','此地址仅接受浏览器 WebSocket');
   },
   // LibVNCServer requires an Origin even on the authenticated loopback hop.
   // Supply only the fixed upstream origin; never forward client credentials.
   wsClientOptions:{origin:spec.vncEndpoint,rewriteRequestHeaders:()=>({})},replyOptions:{rewriteRequestHeaders:()=>({})}
  });
 }
}
