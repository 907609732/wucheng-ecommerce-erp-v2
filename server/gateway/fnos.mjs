import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
const contexts=new WeakMap();
export const fnosContext=raw=>contexts.get(raw);
const deny=(statusCode,code,message)=>Object.assign(Error(message),{statusCode,code,workbenchPublic:true});
const lan=host=>host==='localhost'||host==='127.0.0.1'||/^10\.\d+\.\d+\.\d+$/.test(host)||/^192\.168\.\d+\.\d+$/.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
export function validateFnos(value){
  if(value===undefined)return {enabled:false};
  if(!value||typeof value.enabled!=='boolean')throw Error('飞牛入口配置无效');
  if(!value.enabled)return {enabled:false};
  const c=structuredClone(value);
  if(typeof c.instanceId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(c.instanceId)||!path.isAbsolute(c.socketPath||'')||c.basePrefix!=='/app/wuchengerp')throw Error('飞牛入口需要实例、完整socket路径和固定应用前缀');
  if(!Array.isArray(c.allowedUids)||!c.allowedUids.length||c.allowedUids.some(u=>typeof u!=='string'||!/^(?:0|[1-9]\d{0,9})$/.test(u)))throw Error('飞牛入口需要显式UID名单');
  if(!Array.isArray(c.allowedOrigins)||!c.allowedOrigins.length)throw Error('飞牛入口需要显式允许源');
  c.allowedOrigins=c.allowedOrigins.map(value=>{const u=new URL(value);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||u.protocol==='http:'&&lan(u.hostname)))throw Error('飞牛外网入口必须HTTPS，HTTP仅限明确局域网地址');return u.origin;});
  return c;
}
export function fnosIdentity(request,c){
  const host=request.headers.host;
  const matches=c.allowedOrigins.filter(origin=>{const u=new URL(origin);return host===u.host||host===u.hostname;});
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
export function createFnosListener(app,c){
  let server,owned;
  return {
    async start(){
      if(!c.enabled)return;
      if(process.platform==='win32')throw Error('飞牛Unix入口仅支持Unix系统');
      const parent=path.dirname(c.socketPath);let current=path.parse(parent).root;
      for(const segment of parent.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,segment);if(fs.lstatSync(current).isSymbolicLink())throw Error('飞牛socket父目录不能是符号链接');}
      const st=fs.statSync(parent);if(!st.isDirectory()||(st.mode&0o022))throw Error('飞牛socket父目录必须受控且不可被其他用户写入');
      if(fs.existsSync(c.socketPath))throw Error('飞牛socket路径已存在，拒绝覆盖');
      server=http.createServer((req,res)=>{
        const url=req.url||'';
        const pathname=url.split('?')[0];
        if(!(pathname===c.basePrefix||pathname.startsWith(c.basePrefix+'/'))||/[\\]/.test(pathname)||/%(?:2f|5c|2e|00)/i.test(pathname)||pathname.split('/').some(p=>p==='.'||p==='..')){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,code:'FNOS_PATH_INVALID'}));return;}
        contexts.set(req,{publicPrefix:c.basePrefix});req.url=(pathname===c.basePrefix?'/':'')+url.slice(c.basePrefix.length);app.routing(req,res);
      });
      // Bind at a private temporary name. libuv unlinks its bound name on close;
      // publishing a hard link lets our inode check protect a later replacement.
      const temporary=path.join(parent,'.erp-'+randomUUID());
      const previous=process.umask(0o177);
      let listening;
      try{listening=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(temporary,resolve);});}finally{process.umask(previous);}
      await listening;
      fs.chmodSync(temporary,0o600);
      const bound=fs.lstatSync(temporary);
      fs.linkSync(temporary,c.socketPath); // Atomic no-clobber publish; never overwrites a file/socket.
      owned=bound;
      fs.unlinkSync(temporary);
    },
    async stop(){if(server?.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));if(owned){try{const now=fs.lstatSync(c.socketPath);if(now.ino===owned.ino&&now.dev===owned.dev&&now.isSocket())fs.unlinkSync(c.socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}owned=null;}}
  };
}
