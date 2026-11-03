import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(resources){
 const frame=new EventTarget(),retry=new EventTarget(),window=new EventTarget(),status={},message={};let reloads=0;
 Object.assign(frame,{hidden:true,getAttribute:()=>'/apps/purchase/',contentDocument:{querySelector:()=>({})},contentWindow:{performance:{getEntriesByType:()=>resources},location:{reload(){reloads++;}}}});
 const nodes={'#status':status,'#message':message,'#workspace':frame,'#retry':retry};
 vm.runInNewContext(fs.readFileSync(new URL('../server/public/shell.js',import.meta.url),'utf8'),{document:{querySelector:s=>nodes[s],querySelectorAll:()=>[]},window,location:{hash:'#purchase'},fetch:async()=>({ok:true,json:async()=>({actor:{login:'local-development'}})})});
 return {frame,retry,message,reloads:()=>reloads};
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
