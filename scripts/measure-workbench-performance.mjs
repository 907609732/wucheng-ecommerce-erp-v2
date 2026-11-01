import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {_electron as electron} from 'playwright';
const [exe,output]=process.argv.slice(2);
if(!exe||!output)throw Error('Usage: node scripts/measure-workbench-performance.mjs EXE REPORT');
const runs=[];
for(let i=0;i<5;i++){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-perf-'));
 const registry=path.join(root,'registry.json');
 fs.writeFileSync(registry,JSON.stringify(Object.fromEntries(['warehouse','purchase','sales','overview','exporter'].map(id=>[id,{managed:true,root:path.join(root,id),dataDir:path.join(root,'data',id),exe:path.join(root,id,'missing.exe')}]))));
 const env={...process.env,LINGTU_REGISTRY_PATH:registry,LINGTU_SKIP_BUNDLED_ACTIVATION:'1',LINGTU_TEST_DISABLE_TRAY:'1',LINGTU_ISOLATED_TEST:'1'};delete env.ELECTRON_RUN_AS_NODE;
 let app;const start=performance.now();
 try{
  app=await electron.launch({executablePath:path.resolve(exe),args:['--user-data-dir='+root],env});
  const page=await app.firstWindow();await page.locator('#cards button').first().waitFor();
  const firstScreenMs=performance.now()-start;
  const host=path.join(root,'host.json'),writes=[];let previous;
  for(let t=0;t<6;t++){
   await new Promise(r=>setTimeout(r,1000));
   const stamp=fs.existsSync(host)?fs.statSync(host).mtimeMs:null;if(previous!==undefined&&stamp!==previous)writes.push(stamp);previous=stamp;
  }
  const metrics=await app.evaluate(({app})=>app.getAppMetrics().map(x=>({type:x.type,cpu:x.cpu.percentCPUUsage,memoryKB:x.memory.workingSetSize})));
  runs.push({firstScreenMs:Math.round(firstScreenMs),idleHeartbeatWrites:writes.length,cpuPercent:metrics.reduce((n,x)=>n+x.cpu,0),workingSetKB:metrics.reduce((n,x)=>n+x.memoryKB,0)});
 }finally{await app?.close();}
}
const sorted=runs.map(x=>x.firstScreenMs).sort((a,b)=>a-b);
const report={scope:'Five fresh isolated profiles on this Windows host; no business database, collection, login or external network. Cold process launch, not cold OS cache.',runs,medianFirstScreenMs:sorted[2],p95FirstScreenMs:sorted[4],checkedAt:new Date().toISOString()};
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
