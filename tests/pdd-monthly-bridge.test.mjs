import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=file=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
test('standalone PDD preload exposes dedicated calls and unsubscribable progress without purchase imports',()=>{
  let api;const calls=[],events=new Map();
  const ipcRenderer={invoke:async(...args)=>{calls.push(args);return {};},on:(name,listener)=>events.set(name,listener),removeListener:(name,listener)=>{if(events.get(name)===listener)events.delete(name);}};
  vm.runInNewContext(read('desktop/preload.cjs'),{require:()=>({contextBridge:{exposeInMainWorld:(_,value)=>api=value},ipcRenderer})});
  for(const key of ['getPddMonthlyState','openPddMonthly','startPddMonthly','stopPddMonthly','exportPddMonthly','onPddMonthlyProgress'])assert.equal(typeof api[key],'function',key);
  api.getPddMonthlyState();api.openPddMonthly({month:'2026-09'});api.startPddMonthly({month:'2026-09'});api.stopPddMonthly();api.exportPddMonthly({id:'result'});
  assert.deepEqual(calls.map(c=>c[0]),['pdd-monthly:state','pdd-monthly:open','pdd-monthly:start','pdd-monthly:stop','pdd-monthly:export']);
  let received;const unsubscribe=api.onPddMonthlyProgress(value=>received=value);events.get('pdd-monthly:progress')({}, {state:'running'});assert.equal(received.state,'running');unsubscribe();assert.equal(events.has('pdd-monthly:progress'),false);
});
test('dedicated PDD IPC uses its own module and binds export to current result and native save dialog',async()=>{
  const source=read('desktop/main.mjs');
  const start=source.indexOf("ipcMain.handle('pdd-monthly:state'"),end=source.indexOf("ipcMain.handle('invoice:logs'",start);
  assert(start>=0&&end>start,'独立模块必须拥有完整专用 IPC 处理器');
  const handlers=new Map(),calls=[],saveCalls=[];
  const service={state:()=>({state:'completed',result:{id:'current',month:'2026-09'}}),open:async p=>calls.push(['open',p]),start:p=>calls.push(['start',p]),stop:async()=>({state:'canceled'}),exportResult:async(p,file)=>{calls.push(['export',p,file]);return {file,orderCount:1,itemCount:2};}};
  vm.runInNewContext(source.slice(start,end),{ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},moduleSender:()=>{},getPddMonthlyExporter:()=>service,runtimeMode:()=> 'standalone',mainWindow:{},dialog:{showSaveDialog:async(_,options)=>{saveCalls.push(options);return {canceled:false,filePath:'C:/chosen/pdd.xlsx'};}},localPurchase:()=>{throw Error('独立导出不得访问采购数据库');}});
  assert.equal(handlers.size,5);
  const opened=await handlers.get('pdd-monthly:open')({}, {month:'2026-09'});assert.ok(opened);
  await handlers.get('pdd-monthly:start')({}, {month:'2026-09'});
  await assert.rejects(Promise.resolve().then(()=>handlers.get('pdd-monthly:export')({}, {id:'stale',file:'C:/evil.xlsx'})),/结果|重新|采集/);
  assert.equal(saveCalls.length,0,'过期结果不能打开保存对话框');
  const out=await handlers.get('pdd-monthly:export')({}, {id:'current',file:'C:/evil.xlsx'});assert.equal(out.file,'C:/chosen/pdd.xlsx');
  const exportCall=calls.find(c=>c[0]==='export');assert.equal(exportCall[1].id,'current');assert.equal(Object.hasOwn(exportCall[1],'file'),false);assert.equal(exportCall[2],'C:/chosen/pdd.xlsx');
});
