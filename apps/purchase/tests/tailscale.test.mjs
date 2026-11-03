import test from 'node:test';
import assert from 'node:assert/strict';
import {createTailscale,describeTailscale} from '../lib/tailscale.mjs';
const origin='https://purchase.test.ts.net';
const serve={TCP:{443:{HTTPS:true}},Web:{'purchase.test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:17869'}}}}};
test('状态依据后台而非客户端窗口，并校验私有代理配置',()=>{
 const running={BackendState:'Running',Self:{Online:true}};
 assert.equal(describeTailscale(running,serve,origin).serveReady,true);
 assert.equal(describeTailscale(running,serve,origin).connected,true);
 assert.equal(describeTailscale(running,serve,'https://other.test.ts.net').serveReady,false);
 assert.equal(describeTailscale(running,{...serve,AllowFunnel:{'purchase.test.ts.net:443':true}},origin).serveReady,false);
 assert.match(describeTailscale({BackendState:'Stopped'},null,origin).message,/未连接/);
 assert.match(describeTailscale({BackendState:'NeedsLogin'},null,origin).message,/登录/);
 assert.equal(describeTailscale({BackendState:'Running',Self:{Online:false}},serve,origin).connected,false);
});
test('使用固定程序与参数、状态合并缓存、启动按钮限频且不执行用户命令',async()=>{
 let calls=[],opened=[],now=10000;
 const manager=createTailscale({platform:'win32',exists:()=>true,now:()=>now,execute:async(file,args,options)=>{calls.push({file,args,options});return {stdout:JSON.stringify(args[0]==='status'?{BackendState:'Running',Self:{Online:true}}:serve)};},launch:async file=>opened.push(file)});
 const [a,b]=await Promise.all([manager.status(origin),manager.status(origin)]);assert.equal(a.connected,true);assert.deepEqual(a,b);assert.equal(calls.length,2);
 await manager.status(origin);assert.equal(calls.length,2);assert.deepEqual(calls[0].args,['status','--json']);assert.deepEqual(calls[1].args,['serve','status','--json']);assert.equal(calls[0].options.windowsHide,true);
 await manager.open();await manager.open();assert.equal(opened.length,1);assert.match(opened[0],/tailscale-ipn\.exe$/);now+=5000;await manager.open();assert.equal(opened.length,2);
});
test('缺少安装或后台无响应有明确提示，错误输出不泄露',async()=>{
 const missing=createTailscale({platform:'win32',exists:()=>false});assert.equal((await missing.status(origin)).state,'NotInstalled');await assert.rejects(()=>missing.open());
 const broken=createTailscale({platform:'win32',exists:()=>true,execute:async()=>{throw Error('sensitive raw error');}});const result=await broken.status(origin);assert.equal(result.state,'Unavailable');assert.ok(!JSON.stringify(result).includes('sensitive'));
});
