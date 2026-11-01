import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unitTests,TEST_UNITS} from './verification-config.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),id=process.argv[2];
if(!TEST_UNITS.includes(id))throw Error('Unknown test unit');
const files=unitTests(root,id),directory=path.join(root,'tooling/build-units',id,'.verification');fs.mkdirSync(directory,{recursive:true});
const started=Date.now(),phases=[];let log='';
function run(name,args,cwd){const start=Date.now(),result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',windowsHide:true,timeout:15*60*1000,maxBuffer:32*1024*1024});log+='\n'+name+'\n'+(result.stdout||'')+'\n'+(result.stderr||'');phases.push({name,elapsedMs:Date.now()-start,exitCode:result.status,signal:result.signal||null,error:result.error?.message||null,passed:result.status===0});}
if(files.length)run('root-node-tests',['--test','--test-concurrency=2',...files],root);
if(['purchase','sales','overview'].includes(id)){const cwd=path.join(root,'apps',id),folder=id==='sales'?'test':'tests',tests=fs.readdirSync(path.join(cwd,folder)).filter(n=>/\.test\.[cm]?js$/.test(n)).sort().map(n=>folder+'/'+n);if(!tests.length)throw Error('No business tests found for '+id);run('module-node-tests',['--test','--test-concurrency=2',...tests],cwd);}
if(id==='exporter')run('module-vitest',[path.join(root,'apps/exporter/node_modules/vitest/vitest.mjs'),'run','--maxWorkers=2'],path.join(root,'apps/exporter'));
const passed=phases.length>0&&phases.every(p=>p.passed);
fs.writeFileSync(path.join(directory,'tests.log'),log);
fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({id,files,elapsedMs:Date.now()-started,phases,passed},null,2));
if(!passed){process.stderr.write(log);process.exitCode=1;}else console.log(JSON.stringify({id,files:files.length,phases,elapsedMs:Date.now()-started}));
