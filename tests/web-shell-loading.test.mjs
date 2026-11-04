import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(resources,{started=false,hash='#purchase',summary={enabled:true,pending:2,failed:1}}={}){
 const frame=new EventTarget(),retry=new EventTarget(),window=new EventTarget(),document=new EventTarget(),status={},message={},classes=new Set(),hosting={hidden:true,classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},add(name){classes.add(name);}}};let reloads=0,timerId=0;
 const timers=new Map(),requests=[],location={hash};
 const links=['purchase','sales','overview','data-versions'].map(id=>({hash:'#'+id,attributes:{},setAttribute(name,value){this.attributes[name]=value;}}));
 Object.assign(frame,{hidden:true,src:'/apps/purchase/',getAttribute(){return this.src;},contentDocument:{documentElement:{dataset:{businessStarted:String(started)}},querySelector:()=>({})},contentWindow:{performance:{getEntriesByType:()=>resources},location:{reload(){reloads++;}}}});
 const nodes={'#status':status,'#message':message,'#workspace':frame,'#retry':retry,'#hosting-status':hosting};
 Object.assign(document,{hidden:false,querySelector:s=>nodes[s],querySelectorAll:()=>links});
 vm.runInNewContext(fs.readFileSync(new URL('../server/public/shell.js',import.meta.url),'utf8'),{document,window,location,AbortController,setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('/session')?{actor:{login:'local-development',label:'公司成员'}}:summary};}});
 return {frame,retry,message,status,hosting,classes,document,window,location,links,timers,requests,reloads:()=>reloads};
}
test('启动脚本失败不能永远停在加载画面，重试只重载当前页面',async()=>{
 const f=fixture([{name:'http://127.0.0.1/apps/purchase/app.js',responseStatus:503}]);await new Promise(r=>setImmediate(r));
 f.frame.dispatchEvent(new Event('load'));
 assert.equal(f.message.hidden,false);assert.match(f.message.textContent,/资源.*加载失败/);assert.equal(f.retry.hidden,false);
 f.retry.dispatchEvent(new Event('click'));assert.equal(f.reloads(),1);
});
test('成功加载资源及业务API失败不触发脚本加载重试',async()=>{
 const f=fixture([{name:'http://127.0.0.1/apps/purchase/app.js',responseStatus:200},{name:'http://127.0.0.1/apps/purchase/api/report',responseStatus:503}]);await new Promise(r=>setImmediate(r));f.frame.dispatchEvent(new Event('load'));assert.equal(f.message.hidden,true);assert.equal(f.reloads(),0);
});
test('业务入口已执行时，辅助脚本失败和bootstrap延迟不能隐藏正在启动的页面',async()=>{
 const f=fixture([{name:'http://127.0.0.1/apps/purchase/loading-screen-auto.mjs',responseStatus:503}],{started:true});await new Promise(r=>setImmediate(r));f.frame.dispatchEvent(new Event('load'));assert.equal(f.message.hidden,true);assert.equal(f.reloads(),0);assert.equal(f.frame.hidden,false);
});

test('数据版本导航使用独立页面与托管状态，轮询不覆盖已验证连接状态',async()=>{
 const f=fixture([],{hash:'#data-versions'});await new Promise(r=>setImmediate(r));
 assert.equal(f.requests[0].url,'/api/workbench/v1/session');
 assert.equal(f.requests[1].url,'/api/workbench/v1/data-versions/summary');
 assert.equal(f.frame.src,'/web/data-versions.html');
 assert.equal(f.frame.title,'数据版本');
 assert.equal(f.links[3].attributes['aria-current'],'page');
 assert.equal(f.status.textContent,'开发模式 · 隔离数据');
 assert.equal(f.hosting.textContent,'待托管 2 / 托管异常 1');
 assert.equal(f.classes.has('hosting-error'),true);
 const poll=[...f.timers.values()].find(timer=>timer.delay===60000);assert.ok(poll);await poll.callback();
 assert.equal(f.requests.length,3);assert.equal(f.status.textContent,'开发模式 · 隔离数据');
 f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
 assert.equal(f.timers.size,0);assert.equal(f.requests.at(-1).options.signal.aborted,true);
 f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await new Promise(r=>setImmediate(r));
 assert.equal(f.requests.length,4);
 f.location.hash='#sales';f.window.dispatchEvent(new Event('hashchange'));assert.equal(f.frame.src,'/apps/sales/');
 f.window.dispatchEvent(new Event('pagehide'));assert.equal(f.timers.size,0);
});

test('托管禁用时保留会话状态且隐藏独立托管提示',async()=>{
 const f=fixture([],{summary:{enabled:false,pending:0,failed:0}});await new Promise(r=>setImmediate(r));
 assert.equal(f.hosting.hidden,true);assert.equal(f.status.textContent,'开发模式 · 隔离数据');
});
