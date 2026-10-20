import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';

export async function startCloudControl({root, dataDir, version, busy, activate, open, stop}) {
  let maintenance = process.env.LINGTU_MAINTENANCE === '1', stopping = false;
  const keyFile = path.join(dataDir, '.integration-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), {flag:'wx', mode:0o600});
  const token = 'Bearer ' + fs.readFileSync(keyFile, 'utf8').trim();
  const runtimeFile = path.join(dataDir, '.integration-runtime-cloud.json');
  const state = {id:'lingtu-warehouse',apiVersion:1,root,dataDir,version,pid:process.pid,capabilities:['warehouse.read','warehouse.run','module.lifecycle']};
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try {
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
          !/^127\.0\.0\.1:\d+$/.test(req.headers.host||'') || req.headers.origin) return send(403,{error:'仅允许本机授权调用'});
      if (req.method === 'GET' && req.url === '/api/integration/v1/capabilities') return send(200,{...state,busy:busy(),maintenance,stopping});
      const auth = Buffer.from(String(req.headers.authorization||'')), expected = Buffer.from(token);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401,{error:'本机授权无效'});
      if (req.method !== 'POST') return send(405,{error:'操作不支持'});
      let body = '';
      for await (const chunk of req) {body += chunk;if(body.length>1024)return send(413,{error:'请求过大'});}
      if (JSON.parse(body||'{}').confirm !== true) return send(400,{error:'需要明确操作'});
      if (req.url === '/api/integration/v1/maintenance/activate') {
        await activate();maintenance=false;return send(200,{ok:true});
      }
      if (req.url === '/api/integration/v1/open') {
        if(maintenance)return send(409,{error:'模块尚未完成安装检查'});
        await open();return send(200,{ok:true});
      }
      if (req.url === '/api/integration/v1/stop') {
        if(busy())return send(409,{error:'云仓任务正在执行'});
        stopping=true;send(200,{ok:true});setTimeout(stop,100);return;
      }
      send(404,{error:'未知接口'});
    } catch { if(!res.headersSent)send(400,{error:'操作失败，请检查模块状态'}); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  state.url='http://127.0.0.1:'+server.address().port;
  fs.writeFileSync(runtimeFile,JSON.stringify(state));
  return {close(){server.close();try{if(JSON.parse(fs.readFileSync(runtimeFile,'utf8')).pid===process.pid)fs.unlinkSync(runtimeFile);}catch{}}};
}
