import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import net from 'node:net';
const contexts=new WeakMap();
export const fnosContext=raw=>contexts.get(raw);
const deny=(statusCode,code,message)=>Object.assign(Error(message),{statusCode,code,workbenchPublic:true});
const lan=host=>host==='localhost'||host==='127.0.0.1'||/^10\.\d+\.\d+\.\d+$/.test(host)||/^192\.168\.\d+\.\d+$/.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
export function validateFnos(value){
  if(value===undefined)return {enabled:false};
  if(!value||typeof value.enabled!=='boolean')throw Error('飞牛入口配置无效');
  if(!value.enabled)return {enabled:false};
  const c=structuredClone(value);
  if(typeof c.instanceId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(c.instanceId)||!path.isAbsolute(c.socketPath||'')||!['/app/wuchengerp','/app/wuchengerptrial'].includes(c.basePrefix))throw Error('飞牛入口需要实例、完整socket路径和受控应用前缀');
  if(!Array.isArray(c.allowedUids)||!c.allowedUids.length||c.allowedUids.some(u=>typeof u!=='string'||!/^(?:0|[1-9]\d{0,9})$/.test(u)))throw Error('飞牛入口需要显式UID名单');
  if(!Array.isArray(c.allowedOrigins)||!c.allowedOrigins.length)throw Error('飞牛入口需要显式允许源');
  c.allowedOrigins=c.allowedOrigins.map(value=>{const u=new URL(value);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||u.protocol==='http:'&&lan(u.hostname)))throw Error('飞牛外网入口必须HTTPS，HTTP仅限明确局域网地址');return u.origin;});
  if(c.hostAliases===undefined)c.hostAliases={};
  if(!c.hostAliases||typeof c.hostAliases!=='object'||Array.isArray(c.hostAliases))throw Error('飞牛Host别名必须为显式映射');
  for(const [host,origin] of Object.entries(c.hostAliases)){
    let u;try{u=new URL('https://'+host);}catch{throw Error('飞牛Host别名无效');}
    if(!host||/[\x00-\x20\x7f\\/@?#*]/.test(host)||u.host!==host||u.pathname!=='/'||u.username||u.password||!c.allowedOrigins.includes(origin))throw Error('飞牛Host别名必须是精确Host并映射到允许源');
    if(!u.hostname.startsWith('[')&&!u.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw Error('飞牛Host别名无效');
  }
  return c;
}
export function fnosIdentity(request,c){
  const host=request.headers.host;
  const matches=Object.hasOwn(c.hostAliases||{},host)?[c.hostAliases[host]]:c.allowedOrigins.filter(origin=>{const u=new URL(origin);return host===u.host||host===u.hostname;});
  if(!matches.length)throw deny(421,'INVALID_HOST','入口地址与飞牛配置不一致');
  const origin=request.headers.origin;
  if(origin&&!matches.includes(origin))throw deny(403,'ORIGIN_DENIED','请求来源不受信任');
  if(['cross-site','same-site'].includes(request.headers['sec-fetch-site']))throw deny(403,'ORIGIN_DENIED','请求来源不受信任');
  // Host can lose its port at the official gateway. An explicit Origin disambiguates configured entries.
  if(!origin&&matches.length!==1)throw deny(421,'AMBIGUOUS_HOST','入口地址无法唯一识别');
  const entryOrigin=origin||matches[0];
  const one=name=>{const count=(request.raw.rawHeaders||[]).filter((v,i)=>i%2===0&&v.toLowerCase()===name).length;const value=request.headers[name];if(count!==1||typeof value!=='string'||!value||/[\r\n,]/.test(value))throw deny(401,'FNOS_IDENTITY_REQUIRED','缺少唯一飞牛身份');return value;};
  const uid=one('x-trim-userid'),label=one('x-trim-username');
  if(!/^(?:0|[1-9]\d{0,9})$/.test(uid)||label.length>254||/[\x00-\x1f\x7f]/.test(label)||!c.allowedUids.includes(uid))throw deny(403,'FNOS_USER_DENIED','此飞牛用户未获授权');
  return {id:'fnos:'+c.instanceId+':'+uid,login:label,label,provider:'fnos',publicPrefix:c.basePrefix,origin:entryOrigin,secure:entryOrigin.startsWith('https:'),cookie:'workbench-fnos-'+c.instanceId+'-'+createHash('sha256').update(entryOrigin).digest('hex').slice(0,12)};
}
const sameInode=(a,b)=>a.ino===b.ino&&a.dev===b.dev;
function socketStat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function cleanStaleSocket(file){
  const before=socketStat(file);if(!before)return;
  if(!before.isSocket()||before.isSymbolicLink()||before.uid!==process.getuid())throw Error('飞牛socket路径存在非本用户socket，拒绝覆盖');
  await new Promise((resolve,reject)=>{
    const probe=net.createConnection({path:file});
    probe.setTimeout(1500,()=>{probe.destroy();reject(Error('飞牛socket状态无法确认，拒绝覆盖'));});
    probe.once('connect',()=>{probe.destroy();reject(Error('飞牛socket已有活动listener，拒绝覆盖'));});
    probe.once('error',error=>{if(error.code==='ECONNREFUSED')resolve();else reject(Error('飞牛socket状态无法确认，拒绝覆盖'));});
  });
  const after=socketStat(file);
  if(!after||!sameInode(before,after)||!after.isSocket()||after.uid!==process.getuid())throw Error('飞牛socket清理前发生变化，拒绝覆盖');
  fs.unlinkSync(file);
}
export function createFnosListener(app,c){
  let server,owned,ownedMarker,boundPath=null;
  const markerPath=c.enabled?path.join(path.dirname(c.socketPath),'app.listener'):null;
  let state=c.enabled?'stopped':'disabled',errorMessage=null;
  const status=()=>({enabled:c.enabled,state,socketPath:c.enabled?c.socketPath:null,boundPath,markerPath,error:errorMessage});
  async function stop(){
    if(server?.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    if(owned){const now=socketStat(c.socketPath);if(now&&sameInode(now,owned)&&now.isSocket())fs.unlinkSync(c.socketPath);owned=null;}
    if(ownedMarker){const now=socketStat(markerPath);if(now?.isFile()&&sameInode(now,ownedMarker)&&fs.readFileSync(markerPath,'utf8')===path.basename(boundPath)+'\n')fs.unlinkSync(markerPath);ownedMarker=null;}
    if(state==='ready')state='stopped';
  }
  return {
    status,stop,
    async start(){
      if(!c.enabled)return;
      state='starting';
      try{
        if(process.platform==='win32')throw Error('飞牛Unix入口仅支持Unix系统');
        const parent=path.dirname(c.socketPath);let current=path.parse(parent).root;
        for(const segment of parent.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,segment);if(fs.lstatSync(current).isSymbolicLink())throw Error('飞牛socket父目录不能是符号链接');}
        const st=fs.statSync(parent);if(!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o022))throw Error('飞牛socket父目录必须由当前用户所有且不可被其他用户写入');
        const previousMarker=socketStat(markerPath);
        if(previousMarker){
          if(!previousMarker.isFile()||previousMarker.uid!==process.getuid()||(previousMarker.mode&0o022)||previousMarker.size>80)throw Error('飞牛listener标记不是受控普通文件');
          const name=fs.readFileSync(markerPath,'utf8');
          if(!/^\.erp-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\n$/.test(name))throw Error('飞牛listener标记内容无效');
          await cleanStaleSocket(path.join(parent,name.trim()));
          await cleanStaleSocket(c.socketPath);
          const currentMarker=socketStat(markerPath);
          if(!currentMarker?.isFile()||!sameInode(previousMarker,currentMarker)||fs.readFileSync(markerPath,'utf8')!==name)throw Error('飞牛listener标记清理前发生变化');
          fs.unlinkSync(markerPath);
        }else await cleanStaleSocket(c.socketPath);
        boundPath=path.join(parent,'.erp-'+randomUUID());
        const prepare=req=>{
          const url=req.url||'',pathname=url.split('?')[0];
          if(contexts.has(req)||!(pathname===c.basePrefix||pathname.startsWith(c.basePrefix+'/'))||/[\\]/.test(pathname)||/%(?:2f|5c|2e|00)/i.test(pathname)||pathname.split('/').some(p=>p==='.'||p==='..'))return false;
          // This capability exists only on requests actually received here.
          contexts.set(req,{publicPrefix:c.basePrefix});req.url=(pathname===c.basePrefix?'/':'')+url.slice(c.basePrefix.length);return true;
        };
        server=http.createServer((req,res)=>{
          if(!prepare(req)){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,code:'FNOS_PATH_INVALID'}));return;}
          app.routing(req,res);
        });
        server.on('upgrade',(req,socket,head)=>{
          if(!prepare(req)){socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
          // The maintained proxy owns framing/upgrading. Forward the original
          // IncomingMessage, socket and head, preserving private transport context.
          if(!app.server.emit('upgrade',req,socket,head))socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        });
        // Each generation has a unique bound name: libuv close can never unlink
        // a later generation. A non-secret marker lets FPK verify its exact name.
        const previous=process.umask(0o177);let listening;
        try{listening=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(boundPath,resolve);});}finally{process.umask(previous);}
        await listening;
        owned=fs.lstatSync(boundPath);
        fs.chmodSync(boundPath,0o600);
        fs.linkSync(boundPath,c.socketPath);
        const marker=fs.openSync(markerPath,'wx',0o644);
        try{ownedMarker=fs.fstatSync(marker);fs.writeFileSync(marker,path.basename(boundPath)+'\n');fs.fchmodSync(marker,0o644);}finally{fs.closeSync(marker);}
        state='ready';errorMessage=null;
      }catch(error){state='degraded';errorMessage=error.message;await stop();throw error;}
    }
  };
}
