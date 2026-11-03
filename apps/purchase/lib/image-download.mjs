import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export const MAX_IMAGE_BYTES=10*1024*1024;
export function isPublicAddress(address){
 try{return ipaddr.process(address).range()==='unicast';}catch{return false;}
}
export function imageUrl(value){
 let url;try{url=new URL(value);}catch{throw Error('图片链接格式无效');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)throw Error('仅支持不含登录信息的公网 HTTP/HTTPS 图片链接');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||(ipaddr.isValid(host)&&!isPublicAddress(host)))throw Error('图片链接不能访问本机或内网地址');
 url.hash='';return url;
}

// Pin the validated DNS result to this socket. Revalidate every redirect.
export async function downloadImage(value,{lookup=dns.lookup,request=(url,options,cb)=>(url.protocol==='https:'?https:http).request(url,options,cb),timeoutMs=10000}={}){
 const controller=new AbortController();let timer;
 const run=async(value,redirects=0)=>{
  const url=imageUrl(value),host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=ipaddr.isValid(host)?[{address:host,family:ipaddr.parse(host).kind()==='ipv4'?4:6}]:await lookup(host,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw Error('图片域名解析到非公网地址，已阻止加载');
  if(controller.signal.aborted)throw Error('图片加载超时，请稍后重试');
  const address=addresses.find(a=>a.family===4)||addresses[0];
  return new Promise((resolve,reject)=>{
   const req=request(url,{method:'GET',agent:false,signal:controller.signal,headers:{Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent':'PurchaseDesk/1.3'},lookup:(_host,options,cb)=>options?.all?cb(null,[address]):cb(null,address.address,address.family)},res=>{
    if([301,302,303,307,308].includes(res.statusCode)){
     const location=res.headers.location;res.destroy();
     if(!location||redirects>=3){reject(Error('图片链接跳转过多或无效'));return;}
     try{resolve(run(new URL(location,url).href,redirects+1));}catch(e){reject(e);}return;
    }
    if(res.statusCode!==200){res.destroy();reject(Error(`图片暂不可用（HTTP ${res.statusCode}）`));return;}
    const mime=String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    if(mime&&!mime.startsWith('image/')&&!['application/octet-stream','binary/octet-stream'].includes(mime)){res.destroy();reject(Error('链接返回的内容不是图片'));return;}
    if(Number(res.headers['content-length'])>MAX_IMAGE_BYTES){res.destroy();reject(Error('图片超过 10 MB，未保存'));return;}
    let bytes=0;const chunks=[];
    res.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_IMAGE_BYTES){res.destroy();reject(Error('图片超过 10 MB，未保存'));}else chunks.push(chunk);});
    res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',()=>reject(Error('图片下载中断，请重试')));res.on('aborted',()=>reject(Error('图片下载中断，请重试')));
   });
   req.on('error',()=>reject(Error(controller.signal.aborted?'图片加载超时，请稍后重试':'图片下载失败，请检查网络后重试')));req.end();
  });
 };
 try{return await Promise.race([run(value),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('图片加载超时，请稍后重试'));},timeoutMs);})]);}
 finally{clearTimeout(timer);controller.abort();}
}
