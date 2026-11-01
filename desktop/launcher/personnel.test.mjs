import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createPersonnelSelection,personnelPartition,decoratePersonnelURL,assertPersonnelSupport} from './personnel.mjs';

test('每次新建主进程身份状态均未选择，模块入口必须先选身份',async()=>{
  const first=createPersonnelSelection();
  assert.deepEqual(first.state(),{role:null,selected:false,label:'请选择身份'});
  assert.throws(()=>first.requireSelected(),{code:'PERSONNEL_REQUIRED'});
  await first.select('boss');assert.equal(first.requireSelected(),'boss');
  assert.equal(createPersonnelSelection().state().selected,false);
});

test('员工不能管理成员权限或读取老板销售快照，老板可以',async()=>{
  const selection=createPersonnelSelection();
  await selection.select('employee');assert.throws(()=>selection.requireBoss(),{code:'PERSONNEL_BOSS_REQUIRED'});
  await selection.select('boss');assert.doesNotThrow(()=>selection.requireBoss());
  await selection.select(null);assert.throws(()=>selection.requireBoss(),{code:'PERSONNEL_REQUIRED'});
  await assert.rejects(selection.select('admin'),/请选择老板或员工/);
  await assert.rejects(selection.select('__proto__'),/请选择老板或员工/);
});

test('切换期间关闭旧视图并清页面数据后才给出新身份，不停止业务后台',async()=>{
  const events=[];let release;
  const selection=createPersonnelSelection({resetViews:()=>events.push('reset'),clearPages:async({previous,next})=>{events.push([previous,next]);if(next==='employee')await new Promise(resolve=>{release=resolve;});}});
  await selection.select('boss');const pending=selection.select('employee');await Promise.resolve();
  assert.equal(selection.state().selected,false);assert.throws(()=>selection.requireSelected(),{code:'PERSONNEL_REQUIRED'});
  await assert.rejects(selection.select('boss'),/正在切换身份/);
  release();await pending;
  assert.deepEqual(events,['reset',[null,'boss'],'reset',['boss','employee']]);
  assert.equal(selection.state().role,'employee');
});

test('清理失败时保持未选择，避免复用旧老板身份',async()=>{
  const selection=createPersonnelSelection({clearPages:async()=>{throw Error('清理失败');}});
  await assert.rejects(selection.select('employee'),/清理失败/);
  assert.equal(selection.state().selected,false);assert.throws(()=>selection.requireSelected(),{code:'PERSONNEL_REQUIRED'});
});

test('仅销售视图按本次身份隔离本地和远程session，不复用旧共享partition',()=>{
  for(const base of ['persist:lingtu-sales','persist:workbench-fixture']){
    const boss=personnelPartition('sales',base,'boss'),employee=personnelPartition('sales',base,'employee');
    assert.notEqual(boss,employee);assert.notEqual(employee,base);
  }
  assert.equal(personnelPartition('purchase','persist:lingtu-purchase',null),'persist:lingtu-purchase');
  assert.throws(()=>personnelPartition('sales','persist:lingtu-sales',null),/请选择/);
});

test('销售首URL携带main选定身份，保留原路径查询和锚点且覆盖旧identity',()=>{
  const result=new URL(decoratePersonnelURL('sales','https://fixture.ts.net:8443/apps/sales/index.html?identity=boss&month=2026-09#tasks','employee'));
  assert.equal(result.searchParams.get('identity'),'employee');assert.equal(result.searchParams.get('month'),'2026-09');
  assert.equal(result.pathname,'/apps/sales/index.html');assert.equal(result.hash,'#tasks');
  assert.equal(decoratePersonnelURL('overview','http://127.0.0.1:1/',null),'http://127.0.0.1:1/');
});

test('旧销售服务没有人员接口声明时拒绝打开，不静默降级',()=>{
  for(const info of [undefined,{}, {required:false}])assert.throws(()=>assertPersonnelSupport(info),{code:'PERSONNEL_UPDATE_REQUIRED'});
  assert.equal(assertPersonnelSupport({required:true,role:null}).required,true);
});

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
  const rejected=deskHarness({beforeOpen:()=>{throw Error('请先选择身份');}});
  await assert.rejects(rejected.desks.open('sales'),/请先选择身份/);
  assert.equal(rejected.counts().ensured,0);assert.equal(rejected.views.length,0);
  const normal=deskHarness();await normal.desks.open('sales');
  assert.equal(normal.loaded[0],'http://127.0.0.1:19000/');assert.equal(normal.views[0].webPreferences.partition,'persist:lingtu-sales');
});

test('真实installDeskViews首次和显式页面加载都调用URL装饰器，reset仅销毁视图',async()=>{
  const h=deskHarness({partitionFor:()=>personnelPartition('sales','persist:lingtu-sales','employee'),decorateURL:(id,url)=>decoratePersonnelURL(id,url,'employee')});
  await h.desks.open('sales');await h.desks.open('sales','/integration-edits.html?draft=fixture');
  assert.equal(new URL(h.loaded[0]).searchParams.get('identity'),'employee');
  const next=new URL(h.loaded[1]);assert.equal(next.searchParams.get('draft'),'fixture');assert.equal(next.searchParams.get('identity'),'employee');
  assert.equal(h.views.length,1);h.desks.reset();assert.equal(h.views[0].closed,true);assert.equal(h.counts().stopped,0);
});

test('尚无视图时切换身份也能取消正在启动的旧身份页面',async()=>{
  let resolveEnsure;const h=deskHarness({ensure:()=>new Promise(resolve=>{resolveEnsure=resolve;})});
  const opening=h.desks.open('sales');await Promise.resolve();h.desks.reset();
  resolveEnsure({url:'http://127.0.0.1:19000'});const result=await opening;
  assert.equal(result.cancelled,true);assert.equal(h.views.length,0);assert.equal(h.loaded.length,0);
});
