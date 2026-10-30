import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function deskHarness(options={}){
  const handlers=new Map(),views=[],loaded=[],files=new Map();let ensured=0,stopped=0;
  class WebContentsView{
    constructor({webPreferences}){
      this.webPreferences=webPreferences;this.visible=false;this.closed=false;views.push(this);
      this.webContents={session:{on(){}},mainFrame:{},on(){},setWindowOpenHandler(){},loadURL:async url=>loaded.push(url),focus(){},close:()=>{this.closed=true;},isDestroyed:()=>this.closed};
    }
    setBounds(){}
    setVisible(value){this.visible=value;}
  }
  const manager={registryFile:'/isolated/registry.json',ensure:async id=>{ensured++;return options.ensure?options.ensure(id):{url:'http://127.0.0.1:19000'};},stop:async()=>{stopped++;},status:()=>[]};
  const win={webContents:{mainFrame:{},send(){}},contentView:{addChildView(){},removeChildView(){}},on(){},getContentBounds:()=>({width:1100,height:800})};
  const source=readFileSync(new URL('../local-desks.mjs',import.meta.url),'utf8')
    .replace(/^import .*\r?\n/gm,'').replace('const here=path.dirname(fileURLToPath(import.meta.url));',"const here='/isolated/desktop';")
    .replace('export function installDeskViews','function installDeskViews');
  const install=new vm.Script(source+'\ninstallDeskViews;').runInNewContext({WebContentsView,path,process:{pid:19000},Date,Map,Set,Number,JSON,URL,
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)},shell:{},
    fs:{mkdirSync(){},writeFileSync:(name,value)=>files.set(name,value),readFileSync:name=>{if(files.has(name))return files.get(name);throw Error('not found');},unlinkSync:name=>files.delete(name)},
    setInterval:()=>({unref(){}}),clearInterval(){},ServiceManager:class{}
  });
  const desks=install(win,{manager,...options});
  return {desks,views,loaded,handlers,counts:()=>({ensured,stopped})};
}

test('beforeOpen在启动服务前拦截，默认调用者仍保留原URL和partition',async()=>{
  const rejected=deskHarness({beforeOpen:()=>{throw Error('真实登录尚未完成');}});
  await assert.rejects(rejected.desks.open('sales'),/真实登录尚未完成/);
  assert.equal(rejected.counts().ensured,0);assert.equal(rejected.views.length,0);
  const normal=deskHarness();await normal.desks.open('sales');
  assert.equal(normal.loaded[0],'http://127.0.0.1:19000/');assert.equal(normal.views[0].webPreferences.partition,'persist:lingtu-sales');
});

test('真实公司分区不注入人工角色，reset仅销毁视图',async()=>{
  const h=deskHarness({partitionFor:()=> 'persist:workbench-company-fixture'});
  await h.desks.open('sales');await h.desks.open('sales','/integration-edits.html?draft=fixture');
  assert.equal(new URL(h.loaded[0]).searchParams.has('identity'),false);
  const next=new URL(h.loaded[1]);assert.equal(next.searchParams.get('draft'),'fixture');assert.equal(next.searchParams.has('identity'),false);
  assert.equal(h.views.length,1);h.desks.reset();assert.equal(h.views[0].closed,true);assert.equal(h.counts().stopped,0);
});

test('尚无视图时切换公司连接也能取消正在启动的旧页面',async()=>{
  let resolveEnsure;const h=deskHarness({ensure:()=>new Promise(resolve=>{resolveEnsure=resolve;})});
  const opening=h.desks.open('sales');await Promise.resolve();h.desks.reset();
  resolveEnsure({url:'http://127.0.0.1:19000'});const result=await opening;
  assert.equal(result.cancelled,true);assert.equal(h.views.length,0);assert.equal(h.loaded.length,0);
});

