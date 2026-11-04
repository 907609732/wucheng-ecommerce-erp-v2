import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createDataVersionWorker} from '../server/data-version/worker.mjs';
import {createUvcsAdapter,runCm,inspectOrphanProcesses} from '../server/data-version/uvcs.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-version-worker-'));
  const config = {dataVersion:{enabled:true, dir:path.join(root,'versions'), workspace:path.join(root,'uvcs'), repository:'synthetic@localhost:8087', cmPath:'cm'}, modules:{}};
  const sources = {};
  for (const [module,file] of [['purchase','purchases.sqlite'],['sales','sales.sqlite']]) {
    const dataDir = path.join(root,'data',module); fs.mkdirSync(dataDir,{recursive:true});
    config.modules[module] = {dataDir};
    const db = new DatabaseSync(path.join(dataDir,file));
    db.exec('CREATE TABLE data_version_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL)'); sources[module] = db;
  }
  fs.mkdirSync(config.dataVersion.workspace,{recursive:true});
  const workers=[];
  t.after(async()=>{for(const w of workers)await w.close();for(const db of Object.values(sources))db.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,config,sources,worker(adapter){const w=createDataVersionWorker({config,adapter});workers.push(w);return w;}, event(id='event-1', module='purchase', options={}) {
    const eventDir=path.join(config.dataVersion.dir,'events',module,id); fs.mkdirSync(path.join(eventDir,'attachments'),{recursive:true});
    const body=JSON.stringify({tables:{ledger:[{amount:options.amount??12345}]}});fs.writeFileSync(path.join(eventDir,'snapshot.json'),body);
    fs.writeFileSync(path.join(eventDir,'attachments','invoice.txt'),'original invoice');
    const event={schemaVersion:1,id,module,createdAt:options.createdAt??'2026-11-04T01:00:00.000Z',actor:{id:options.actor??'member-1',label:'成员甲'},action:'批量导入',summary:'新增1条',counts:{insert:1,update:0,delete:0},snapshot:{path:'snapshot.json',sha256:crypto.createHash('sha256').update(body).digest('hex')},attachments:[{path:'attachments/invoice.txt',sha256:'bfd942ae077c69f331037e49c5cfc67448a9a6619f412fbe4b8f087bba3c3b16f',bytes:16}]};
    event.attachments[0].sha256=crypto.createHash('sha256').update('original invoice').digest('hex');
    if(options.committed!==false)sources[module].prepare('INSERT INTO data_version_events VALUES(?,?)').run(id,JSON.stringify(event));
    return {event,eventDir,save(){sources[module].prepare('UPDATE data_version_events SET payload=? WHERE id=?').run(JSON.stringify(event),id);}};
  }};
}
const success = {async findEvent(){return null;},async commit(){return {changeset:'cs:42',submittedAt:'2026-11-04T02:00:00.000Z'};}};

test('worker reads only committed outbox rows, never orphan event folders or uncommitted writes',async t=>{
  const f=fixture(t);f.event('orphan','purchase',{committed:false});f.event();
  f.sources.sales.exec('BEGIN');f.event('uncommitted','sales');
  const uploaded=[];const w=f.worker({...success,async commit(e){uploaded.push(e.id);return {changeset:'cs:42'};}});
  await w.tick();assert.deepEqual(uploaded,['event-1']);assert.equal(w.list({}).total,1);
  f.sources.sales.exec('ROLLBACK');
});

test('offline failure is persisted, automatically backed off, then manual retry submits without resaving business',async t=>{
  const f=fixture(t);f.event();let offline=true;let attempts=0;
  const adapter={...success,async findEvent(){attempts++;if(offline)throw Error('offline '+f.root+' secret-token');return null;}};
  const w=f.worker(adapter);await w.tick();assert.equal(w.detail('event-1').status,'failed');assert.equal(w.detail('event-1').attempts,1);
  assert.equal(w.detail('event-1').error,'UVCS_UNAVAILABLE');await w.tick();assert.equal(attempts,1);
  await w.close();const resumed=f.worker(adapter);assert.equal(resumed.detail('event-1').attempts,1);
  offline=false;resumed.retry('event-1');await resumed.tick();assert.equal(resumed.detail('event-1').changeset,'cs:42');assert.equal(resumed.summary().submitted,1);
});

test('remote event ID deduplication recovers a lost successful response after restart',async t=>{
  const f=fixture(t);f.event();let remote=null,commits=0;
  const adapter={async findEvent(){return remote;},async commit(){commits++;remote={changeset:'cs:91',submittedAt:'2026-11-04T03:00:00.000Z'};throw Error('connection lost after commit');}};
  const w=f.worker(adapter);await w.tick();assert.equal(w.detail('event-1').status,'failed');await w.close();
  const resumed=f.worker(adapter);resumed.retry('event-1');await resumed.tick();assert.equal(resumed.detail('event-1').changeset,'cs:91');assert.equal(commits,1);
});

test('overlapping ticks and workers upload one event at a time with an OS process lock',async t=>{
  const f=fixture(t);f.event('first');f.event('second');let active=0,max=0,commits=0,release,started;
  const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const adapter={...success,async commit(e){active++;max=Math.max(max,active);commits++;if(commits===1){started();await gate;}active--;return {changeset:'cs:'+commits};}};
  const one=f.worker(adapter),two=f.worker(adapter);const a=one.tick();await entered;const b=one.tick();const other=await two.tick();assert.equal(other.busy,true);release();await Promise.all([a,b]);assert.equal(max,1);assert.equal(commits,2);
});

for(const kind of ['snapshot-hash','attachment-hash','escape','symlink'])test('rejects '+kind+' before touching the remote adapter',async t=>{
  const f=fixture(t),entry=f.event();let remote=0;
  if(kind==='snapshot-hash')fs.writeFileSync(path.join(entry.eventDir,'snapshot.json'),'tampered');
  if(kind==='attachment-hash')fs.writeFileSync(path.join(entry.eventDir,'attachments','invoice.txt'),'tampered');
  if(kind==='escape'){entry.event.attachments[0].path='../outside.txt';entry.save();}
  if(kind==='symlink'){const dir=path.join(entry.eventDir,'attachments');fs.rmSync(dir,{recursive:true});const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'invoice.txt'),'original invoice');fs.symlinkSync(outside,dir,'junction');}
  const w=f.worker({...success,async findEvent(){remote++;return null;},async commit(){remote++;return {changeset:'cs:42'};}});await w.tick();assert.equal(remote,0);assert.equal(w.detail('event-1').status,'failed');assert.match(w.detail('event-1').error,/DATA_VERSION_/);
});

test('list filters and totals survive restart and public DTOs omit content, host paths and unrecognized fields',async t=>{
  const f=fixture(t);const one=f.event('first','purchase',{actor:'member-1'});one.event.secret='must not leak';one.save();f.event('second','sales',{actor:'member-2',createdAt:'2026-11-05T01:00:00.000Z'});
  const w=f.worker(success);assert.equal(w.list({module:'purchase',actor:'member-1',status:'pending',from:'2026-11-04',to:'2026-11-04T23:59:59Z'}).total,1);
  await w.tick();await w.close();const resumed=f.worker(success);const list=resumed.list({status:'submitted',limit:1,offset:1});assert.equal(list.total,2);assert.equal(list.items.length,1);
  const output=JSON.stringify(resumed.detail('first'));assert.ok(!output.includes(f.root));assert.ok(!output.includes('12345'));assert.ok(!output.includes('must not leak'));assert.deepEqual(resumed.summary(),{enabled:true,pending:0,failed:0,submitted:2,lastSubmittedAt:'2026-11-04T02:00:00.000Z'});
});

test('disabled configuration neither opens source databases nor creates queue directories',async t=>{
  const f=fixture(t);f.config.dataVersion.enabled=false;f.config.modules.purchase.dataDir=path.join(f.root,'absent');const w=f.worker(success);
  await w.tick();assert.deepEqual(w.list({}),{items:[],total:0});assert.equal(w.summary().enabled,false);assert.equal(fs.existsSync(f.config.dataVersion.dir),false);
});

test('adapter copies only verified manifest files to fixed module paths and parses real cm changeset identifiers',async t=>{
  const f=fixture(t),{event,eventDir}=f.event();fs.writeFileSync(path.join(eventDir,'private-key.txt'),'must never copy');const calls=[];
  const run=async(file,args,options)=>{calls.push({file,args,options});if(args[0]==='fileinfo')return {stdout:'rep:synthetic@repserver:localhost:8087',code:0};if(args[0]==='find')return {stdout:'42|2026-11-04T02:00:00.000Z\n',code:0};if(args[0]==='checkin')return {stdout:"已创建变更集 cs:43@br:/main@synthetic@localhost:8087 (mount:'/')",code:0};return {stdout:'',code:0};};
  const a=createUvcsAdapter({...f.config.dataVersion,run});assert.deepEqual(await a.findEvent('event-1'),{changeset:'cs:42',submittedAt:'2026-11-04T02:00:00.000Z'});
  const committed=await a.commit(event,eventDir);assert.equal(committed.changeset,'cs:43');const target=path.join(f.config.dataVersion.workspace,'purchase');assert.equal(fs.readFileSync(path.join(target,'snapshot.json'),'utf8'),'{"tables":{"ledger":[{"amount":12345}]}}');assert.equal(fs.existsSync(path.join(target,'private-key.txt')),false);
  for(const c of calls){assert.equal(c.options.shell,false);assert.equal(c.options.windowsHide,true);assert.equal(c.options.cwd,f.config.dataVersion.workspace);assert.ok(!c.args.includes('.'));assert.ok(!c.args.includes('-R'));}
  const ci=calls.find(c=>c.args[0]==='checkin');assert.ok(ci.args.some(v=>v.startsWith('-c=采购｜')&&v.includes('事件：event-1')));assert.ok(ci.args.some(v=>v.endsWith('snapshot.json')));assert.ok(!JSON.stringify(calls).includes(eventDir));
});

test('adapter never invents a changeset when CLI reports success without an identifier',async t=>{
  const f=fixture(t),{event,eventDir}=f.event();const a=createUvcsAdapter({...f.config.dataVersion,run:async(_file,args)=>({stdout:args[0]==='fileinfo'?'rep:synthetic@repserver:localhost:8087':'Success',code:0})});
  await assert.rejects(a.commit(event,eventDir),/UVCS_CHANGESET_UNCONFIRMED/);
});

test('adapter remote lookup uses exact stable event marker and rejects query injection',async t=>{
  const f=fixture(t);let query;const a=createUvcsAdapter({...f.config.dataVersion,run:async(_file,args)=>{query=args;return {stdout:'',code:0};}});
  assert.equal(await a.findEvent('event-1'),null);assert.ok(query.some(s=>s.includes("comment like '%事件：event-1]'")));await assert.rejects(a.findEvent("x' or 1=1"),/DATA_VERSION_INVALID_EVENT/);
});


test('automatic retry after backoff preserves chronological versions instead of skipping the failed head',async t=>{
  const f=fixture(t);f.event('older','purchase',{createdAt:'2026-11-04T01:00:00.000Z'});f.event('newer','purchase',{createdAt:'2026-11-04T01:00:01.000Z'});let offline=true;const uploaded=[];
  const w=f.worker({...success,async findEvent(){if(offline)throw Error('offline');return null;},async commit(e){uploaded.push(e.id);return {changeset:'cs:'+uploaded.length};}});
  await w.tick();offline=false;await w.tick();assert.deepEqual(uploaded,[]);
  await new Promise(resolve=>setTimeout(resolve,1100));await w.tick();assert.deepEqual(uploaded,['older','newer']);
});

test('adapter can commit again after all attachments were removed from the fixed module snapshot',async t=>{
  const f=fixture(t);const first=f.event('first'),second=f.event('second'),third=f.event('third');second.event.attachments=[];third.event.attachments=[];let changeset=0;const removed=[];
  const a=createUvcsAdapter({...f.config.dataVersion,run:async(_file,args)=>{
    if(args[0]==='fileinfo')return {stdout:'rep:synthetic@repserver:localhost:8087',code:0};
    if(args[0]==='remove'){removed.push(args[1]);fs.unlinkSync(args[1]);}
    return {stdout:args[0]==='checkin'?'Created changeset cs:'+ ++changeset+'@br:/main@synthetic@localhost:8087':'',code:0};
  }});
  await a.commit(first.event,first.eventDir);await a.commit(second.event,second.eventDir);await a.commit(third.event,third.eventDir);
  assert.equal(changeset,3);assert.deepEqual(removed,[path.join(f.config.dataVersion.workspace,'purchase','attachments','invoice.txt')]);assert.equal(fs.existsSync(path.join(first.eventDir,'attachments','invoice.txt')),true);
});

test('actor filtering accepts a literal name substring without treating SQL wildcards specially',async t=>{
  const f=fixture(t);f.event('one');const second=f.event('two','sales');second.event.actor={id:'other',label:'陈%_同事'};second.save();const w=f.worker(success);
  assert.equal(w.list({actor:'成员'}).total,1);assert.equal(w.list({actor:'%_'}).total,1);assert.equal(w.list({actor:'%'}).items[0].id,'two');
});

test('same-millisecond events preserve source outbox insertion order rather than lexical UUID order',async t=>{
  const f=fixture(t);f.event('z-first');f.event('a-second');const uploaded=[];const w=f.worker({...success,async commit(e){uploaded.push(e.id);return {changeset:'cs:'+uploaded.length};}});
  await w.tick();assert.deepEqual(uploaded,['z-first','a-second']);assert.deepEqual(w.list({}).items.map(e=>e.id),['a-second','z-first']);
});


test('a separate process cannot upload concurrently and a terminated owner releases the OS lock',async t=>{
  const f=fixture(t);f.event();const configFile=path.join(f.root,'worker-config.json');fs.writeFileSync(configFile,JSON.stringify(f.config));
  const workerUrl=new URL('../server/data-version/worker.mjs',import.meta.url).href;
  const code=`import fs from 'node:fs'; import {createDataVersionWorker} from ${JSON.stringify(workerUrl)};
    const config=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const keepAlive=setInterval(()=>{},1000);
    const worker=createDataVersionWorker({config,adapter:{async findEvent(){return null;},async commit(){process.stdout.write('READY\\n');await new Promise(()=>{});}}});
    await worker.tick();clearInterval(keepAlive);await worker.close();`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,configFile],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('child worker did not enter upload')),8000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY')){clearTimeout(timeout);resolve();}});child.on('error',reject);child.on('exit',()=>{clearTimeout(timeout);if(!output.includes('READY'))reject(Error('child exited before upload'));});});
  let commits=0;const w=f.worker({...success,async commit(){commits++;return {changeset:'cs:77'};}});
  assert.equal((await w.tick()).busy,true);assert.equal(commits,0);
  await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  await w.tick();assert.equal(commits,1);assert.equal(w.detail('event-1').changeset,'cs:77');assert.equal(w.detail('event-1').attempts,2);
});

test('official CLI runner enforces command timeout and bounded combined output without exposing stderr',async t=>{
  const f=fixture(t);
  await assert.rejects(runCm(process.execPath,['-e','setTimeout(()=>{},10000)'],{cwd:f.config.dataVersion.workspace,timeout:100,maxBuffer:1000}),/UVCS_TIMEOUT/);
  await assert.rejects(runCm(process.execPath,['-e',"process.stderr.write('private secret'.repeat(10000))"],{cwd:f.config.dataVersion.workspace,timeout:5000,maxBuffer:1000}),/UVCS_OUTPUT_LIMIT/);
});

test('adapter rejects a mismatched repository and unexpected workspace files before changing module data',async t=>{
  const f=fixture(t),{event,eventDir}=f.event();let mutation=0;
  const badRepo=createUvcsAdapter({...f.config.dataVersion,run:async(_file,args)=>{if(args[0]!=='fileinfo')mutation++;return {stdout:'different-repository@localhost:8087',code:0};}});
  await assert.rejects(badRepo.commit(event,eventDir),/UVCS_WORKSPACE_REPOSITORY_MISMATCH/);assert.equal(mutation,0);assert.equal(fs.existsSync(path.join(f.config.dataVersion.workspace,'purchase')),false);
  const target=path.join(f.config.dataVersion.workspace,'purchase');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'unrelated.txt'),'preserve');
  const a=createUvcsAdapter({...f.config.dataVersion,run:async()=>({stdout:'synthetic@localhost:8087',code:0})});
  await assert.rejects(a.commit(event,eventDir),/DATA_VERSION_WORKSPACE_DIRTY/);assert.equal(fs.readFileSync(path.join(target,'unrelated.txt'),'utf8'),'preserve');assert.equal(fs.existsSync(path.join(target,'snapshot.json')),false);
});

test('concurrent close calls wait for the in-flight commit and close the queue only once',async t=>{
  const f=fixture(t);f.event();let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const w=f.worker({...success,async commit(){started();await gate;return {changeset:'cs:88'};}});const tick=w.tick();await entered;
  const first=w.close(),second=w.close();release();await Promise.all([first,second,tick]);await w.close();
  const resumed=f.worker(success);assert.equal(resumed.detail('event-1').changeset,'cs:88');assert.equal(fs.existsSync(path.join(f.config.dataVersion.dir,'events','purchase','event-1','snapshot.json')),true);
});

test('closing immediately after starting a tick does not fail during lock acquisition',async t=>{
  const f=fixture(t);f.event();const w=f.worker(success);const tick=w.tick();await w.close();await tick;
});

for(const failure of ['add-before-remove','checkin-after-remove'])test('durable staging resumes '+failure+' across a new adapter and preserves deletion scope',async t=>{
  const f=fixture(t),first=f.event('before'),second=f.event('interrupted'),third=f.event('following');second.event.attachments=[];third.event.attachments=[];
  let failing=false,failed=false,changeset=0;const successful=[],calls=[];
  const run=async(_file,args)=>{
    calls.push(args);
    if(args[0]==='fileinfo')return {stdout:'synthetic@localhost:8087',code:0};
    if(failing&&!failed&&((failure==='add-before-remove'&&args[0]==='add')||(failure==='checkin-after-remove'&&args[0]==='checkin'))){failed=true;throw Error('simulated interrupted command');}
    if(args[0]==='remove')fs.unlinkSync(args[1]);
    if(args[0]==='checkin'){successful.push(args);return {stdout:'Created changeset cs:'+ ++changeset+'@br:/main',code:0};}
    return {stdout:'',code:0};
  };
  await createUvcsAdapter({...f.config.dataVersion,run}).commit(first.event,first.eventDir);
  failing=true;await assert.rejects(createUvcsAdapter({...f.config.dataVersion,run}).commit(second.event,second.eventDir),/UVCS_UNAVAILABLE/);
  await createUvcsAdapter({...f.config.dataVersion,run}).commit(second.event,second.eventDir);
  const removedPath=path.join(f.config.dataVersion.workspace,'purchase','attachments','invoice.txt');assert.ok(successful[1].includes(removedPath));
  await createUvcsAdapter({...f.config.dataVersion,run}).commit(third.event,third.eventDir);
  assert.equal(changeset,3);assert.equal(fs.existsSync(removedPath),false);assert.equal(fs.existsSync(path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','purchase.json')),false);
});

test('staging remembers initially new directories after interrupted add and includes them after restart',async t=>{
  const f=fixture(t),{event,eventDir}=f.event();let failed=false;const checkins=[],added=[];
  const run=async(_file,args)=>{
    if(args[0]==='fileinfo')return {stdout:'synthetic@localhost:8087',code:0};
    if(args[0]==='add'){added.push(args);if(!failed){failed=true;throw Error('interrupted initial add');}}
    if(args[0]==='checkin'){checkins.push(args);return {stdout:'Created changeset cs:5@br:/main',code:0};}
    return {stdout:'',code:0};
  };
  await assert.rejects(createUvcsAdapter({...f.config.dataVersion,run}).commit(event,eventDir),/UVCS_UNAVAILABLE/);
  await createUvcsAdapter({...f.config.dataVersion,run}).commit(event,eventDir);
  assert.ok(checkins[0].includes(path.join(f.config.dataVersion.workspace,'purchase')));assert.ok(checkins[0].includes(path.join(f.config.dataVersion.workspace,'purchase','attachments')));
  assert.ok(!checkins[0].some(value=>value.includes('.lingtu-data-version-staging')));
});

test('remote deduplication confirms and clears interrupted staging without a duplicate commit',async t=>{
  const f=fixture(t),first=f.event('before'),second=f.event('lost-response'),third=f.event('after-confirmation');second.event.attachments=[];third.event.attachments=[];
  const remote=new Map();let lost=true,changeset=0;
  const run=async(_file,args)=>{
    if(args[0]==='fileinfo')return {stdout:'synthetic@localhost:8087',code:0};
    if(args[0]==='find'){const id=args[2].match(/事件：([^\]]+)\]/)[1];return {stdout:remote.has(id)?remote.get(id)+'|2026-11-04T02:00:00.000Z':'',code:0};}
    if(args[0]==='remove')fs.unlinkSync(args[1]);
    if(args[0]==='checkin'){const id=args.find(value=>value.startsWith('-c=')).match(/事件：([^\]]+)\]/)[1];remote.set(id,++changeset);if(id==='lost-response'&&lost){lost=false;throw Error('remote committed, connection lost');}return {stdout:'Created changeset cs:'+changeset+'@br:/main',code:0};}
    return {stdout:'',code:0};
  };
  await createUvcsAdapter({...f.config.dataVersion,run}).commit(first.event,first.eventDir);
  await assert.rejects(createUvcsAdapter({...f.config.dataVersion,run}).commit(second.event,second.eventDir),/UVCS_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','purchase.json')),true);
  const resumed=createUvcsAdapter({...f.config.dataVersion,run});assert.equal((await resumed.findEvent(second.event.id)).changeset,'cs:2');
  assert.equal(fs.existsSync(path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','purchase.json')),false);
  await resumed.commit(third.event,third.eventDir);assert.equal(changeset,3);
});


async function exitedChildPid() {
  const child=spawn(process.execPath,['-e',''],{shell:false,windowsHide:true,stdio:'ignore'});
  const pid=child.pid;await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return pid;
}
function commandLease(f,overrides={}) {
  const file=path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','command-lease.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  const record={schemaVersion:1,token:crypto.randomUUID(),ownerPid:2147483000,childPid:null,startedAt:'2026-11-04T01:00:00.000Z',executable:path.basename(process.execPath),...overrides};fs.writeFileSync(file,JSON.stringify(record));return file;
}

test('a live orphan CLI PID blocks a new command even when its uploader owner has exited',async t=>{
  const f=fixture(t),deadPid=await exitedChildPid();const file=commandLease(f,{ownerPid:deadPid,childPid:process.pid});
  await assert.rejects(runCm(process.execPath,['-e',"process.stdout.write('must not run')"],{cwd:f.config.dataVersion.workspace,timeout:5000}),/UVCS_COMMAND_BUSY/);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).childPid,process.pid);
});

test('a known exited orphan PID allows safe lease recovery and clears the next completed command lease',async t=>{
  const f=fixture(t),deadPid=await exitedChildPid(),file=commandLease(f,{ownerPid:deadPid,childPid:deadPid});
  const result=await runCm(process.execPath,['-e',"process.stdout.write('recovered')"],{cwd:f.config.dataVersion.workspace,timeout:5000});assert.equal(result.stdout,'recovered');assert.equal(fs.existsSync(file),false);
});

test('an interrupted pre-PID lease queries actual old-parent children and fails closed on a live match or unknown inspection',async t=>{
  const f=fixture(t),deadPid=await exitedChildPid(),file=commandLease(f,{ownerPid:deadPid});let inspections=0;
  const options={cwd:f.config.dataVersion.workspace,timeout:5000,inspectOrphanProcesses:async({ownerPid,executable})=>{inspections++;assert.equal(ownerPid,deadPid);assert.equal(executable,path.basename(process.execPath));return [{pid:process.pid}];}};
  await assert.rejects(runCm(process.execPath,['-e',''],options),/UVCS_COMMAND_BUSY/);assert.equal(inspections,1);assert.equal(fs.existsSync(file),true);
  await assert.rejects(runCm(process.execPath,['-e',''],{...options,inspectOrphanProcesses:async()=>{throw Error('inspection unavailable');}}),/UVCS_COMMAND_LEASE_UNVERIFIED/);
  const result=await runCm(process.execPath,['-e',"process.stdout.write('verified empty')"],{...options,inspectOrphanProcesses:async()=>[]});assert.equal(result.stdout,'verified empty');assert.equal(fs.existsSync(file),false);
});

test('timeout keeps the command lease and its promise pending until the child close event arrives',{timeout:5000},async t=>{
  const f=fixture(t),child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=process.pid;let killed=false,settled=false,signalKilled;const didKill=new Promise(resolve=>signalKilled=resolve);
  child.kill=()=>{killed=true;signalKilled();return true;};
  const file=path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','command-lease.json');
  const running=runCm(process.execPath,[],{cwd:f.config.dataVersion.workspace,timeout:25,killGraceMs:500,spawnProcess:()=>child});running.catch(()=>{settled=true;});
  await didKill;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(killed,true);assert.equal(settled,false);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).childPid,process.pid);
  child.emit('close',1);await assert.rejects(running,/UVCS_TIMEOUT/);assert.equal(fs.existsSync(file),false);
});

test('an unresponsive killed child leaves a durable blocking lease after the bounded close grace expires',async t=>{
  const f=fixture(t),child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=process.pid;child.kill=()=>true;
  const running=runCm(process.execPath,[],{cwd:f.config.dataVersion.workspace,timeout:20,killGraceMs:30,spawnProcess:()=>child});await assert.rejects(running,/UVCS_TIMEOUT/);
  const file=path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','command-lease.json');assert.equal(fs.existsSync(file),true);
  await assert.rejects(runCm(process.execPath,['-e',''],{cwd:f.config.dataVersion.workspace,timeout:5000}),/UVCS_COMMAND_BUSY/);
  child.emit('close',1);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(fs.existsSync(file),false);
});


test('production Windows orphan inspection finds the real matching child and confirms its exit', {skip:process.platform!=='win32'}, async t=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{shell:false,windowsHide:true,stdio:'ignore'});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const matches=await inspectOrphanProcesses({ownerPid:process.pid,executable:path.basename(process.execPath)});assert.ok(matches.some(row=>row.pid===child.pid));
  await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  const after=await inspectOrphanProcesses({ownerPid:process.pid,executable:path.basename(process.execPath)});assert.ok(!after.some(row=>row.pid===child.pid));
});

test('production Linux orphan inspection finds a tagged CLI and confirms its exit', {skip:process.platform!=='linux'}, async t=>{
  const token=crypto.randomUUID();
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{shell:false,stdio:'ignore',env:{...process.env,LINGTU_UVCS_COMMAND_TOKEN:token}});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const query={ownerPid:process.pid,executable:path.basename(process.execPath),token};
  const matches=await inspectOrphanProcesses(query);assert.ok(matches.some(row=>row.pid===child.pid));
  await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  const after=await inspectOrphanProcesses(query);assert.ok(!after.some(row=>row.pid===child.pid));
});

test('Linux command runner tags its spawned CLI with the durable lease token', {skip:process.platform!=='linux'}, async t=>{
  const f=fixture(t);
  const result=await runCm(process.execPath,['-e','process.stdout.write(process.env.LINGTU_UVCS_COMMAND_TOKEN??"")'],{cwd:f.config.dataVersion.workspace,timeout:5000});
  assert.match(result.stdout,/^[a-f0-9-]{36}$/i);
});

test('local retention releases only older confirmed snapshots per module and preserves pending data plus durable metadata',async t=>{
  const f=fixture(t);f.config.dataVersion.localHistoryCount=1;const first=f.event('first'),sales=f.event('sales-only','sales');let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const w=f.worker({...success,async commit(event){if(event.id==='second'){started();await gate;f.event('pending-after-confirmation');}return {changeset:'cs:42'};}});
  await w.tick();const second=f.event('second');const uploading=w.tick();await entered;assert.equal(fs.existsSync(path.join(first.eventDir,'snapshot.json')),true);release();await uploading;
  assert.equal(fs.existsSync(first.eventDir),false);assert.equal(fs.existsSync(second.eventDir),true);assert.equal(fs.existsSync(sales.eventDir),true);
  assert.equal(fs.existsSync(path.join(f.config.dataVersion.dir,'events','purchase','pending-after-confirmation','snapshot.json')),true);assert.equal(w.detail('pending-after-confirmation').status,'pending');assert.equal(w.detail('first').status,'submitted');assert.equal(f.sources.purchase.prepare('SELECT count(*) AS n FROM data_version_events').get().n,3);
});

for(const corruption of ['unexpected-file','changed-hash','symlink'])test('local cleanup '+corruption+' is deferred without downgrading remote success or blocking following uploads',async t=>{
  const f=fixture(t);f.config.dataVersion.localHistoryCount=1;const first=f.event('first');const w=f.worker(success);await w.tick();const outside=path.join(f.root,'operator.txt');fs.writeFileSync(outside,'preserve');
  if(corruption==='unexpected-file')fs.writeFileSync(path.join(first.eventDir,'operator.txt'),'preserve');
  if(corruption==='changed-hash')fs.writeFileSync(path.join(first.eventDir,'snapshot.json'),'operator change');
  if(corruption==='symlink'){fs.unlinkSync(path.join(first.eventDir,'attachments','invoice.txt'));fs.symlinkSync(outside,path.join(first.eventDir,'attachments','invoice.txt'),'file');}
  f.event('second');f.event('third');const warnings=[];t.mock.method(console,'warn',(...args)=>warnings.push(args));await w.tick();
  assert.equal(w.summary().submitted,3);assert.equal(w.detail('first').error,null);assert.equal(fs.existsSync(first.eventDir),true);assert.equal(fs.readFileSync(outside,'utf8'),'preserve');
  const queue=new DatabaseSync(path.join(f.config.dataVersion.dir,'queue.sqlite'),{readOnly:true});const maintenance=queue.prepare('SELECT error FROM data_version_maintenance WHERE id=?').get('first');queue.close();assert.match(maintenance.error,/^DATA_VERSION_/);assert.ok(warnings.length>0);assert.ok(!JSON.stringify(warnings).includes(f.root));
});

test('large manifests use short official stdin add/checkin commands with every Unicode path and a longer checkin timeout',async t=>{
  const f=fixture(t),{event,eventDir}=f.event('large-manifest');event.attachments=[];
  const body=Buffer.from('synthetic evidence'),sha=crypto.createHash('sha256').update(body).digest('hex');
  for(let i=0;i<400;i++){
    const relative='attachments/正式 采购原件 '+String(i).padStart(4,'0')+' '+'long-name-'.repeat(8)+'.txt';fs.writeFileSync(path.join(eventDir,relative),body);event.attachments.push({path:relative,sha256:sha,bytes:body.length});
  }
  const calls=[];const adapter=createUvcsAdapter({...f.config.dataVersion,run:async(_file,args,options)=>{calls.push({args,options});return {stdout:args[0]==='fileinfo'?'synthetic@localhost:8087':args[0]==='checkin'?'Created changeset cs:73@br:/main':'',code:0};}});
  await adapter.commit(event,eventDir);const add=calls.find(call=>call.args[0]==='add'&&call.options.input),checkin=calls.find(call=>call.args[0]==='checkin');
  assert.ok(add,'bulk add must use stdin');assert.ok(checkin.options.input,'bulk checkin must use stdin');
  for(const call of calls){assert.ok(call.args.join(' ').length<16000);assert.equal(call.options.timeout,call.args[0]==='checkin'?600000:60000);}
  const target=path.join(f.config.dataVersion.workspace,event.module),expectedFiles=[path.join(target,'snapshot.json'),...event.attachments.map(item=>path.join(target,item.path)),path.join(target,'event.json')];
  assert.deepEqual(add.options.input.trimEnd().split(/\r?\n/),expectedFiles);assert.deepEqual(checkin.options.input.trimEnd().split(/\r?\n/),[target,path.join(target,'attachments'),...expectedFiles]);
  assert.ok(add.args.includes('-'));assert.ok(checkin.args.includes('-'));assert.ok(add.options.input.endsWith('\n\n'));assert.ok(checkin.options.input.endsWith('\n\n'));assert.ok(!checkin.options.input.includes('.lingtu-data-version-staging'));
});

test('official runner sends stdin as UTF8 terminated by a blank line without shell quoting paths',async t=>{
  const f=fixture(t),input='C:\\版本 工作区\\采购原件 一.txt\nC:\\版本 工作区\\附件 二.txt';
  const result=await runCm(process.execPath,['-e',"process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.stdout.write(input));"],{cwd:f.config.dataVersion.workspace,timeout:5000,input});
  assert.equal(result.stdout,input+'\n\n');
});

test('stdin stream failure safely terminates the child and waits for close before releasing its lease',{timeout:5000},async t=>{
  const f=fixture(t),child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.pid=process.pid;let signalSpawned,signalKilled;const spawned=new Promise(resolve=>signalSpawned=resolve),killed=new Promise(resolve=>signalKilled=resolve);child.kill=()=>{signalKilled();return true;};
  const running=runCm(process.execPath,[],{cwd:f.config.dataVersion.workspace,timeout:1000,input:'file.txt',spawnProcess:(_file,_args,options)=>{assert.equal(options.stdio[0],'pipe');signalSpawned();return child;}});
  const rejected=assert.rejects(running,/UVCS_STDIN_UNAVAILABLE/);await spawned;child.stdin.emit('error',Object.assign(Error('broken input'),{code:'EPIPE'}));await killed;
  assert.equal(fs.existsSync(path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','command-lease.json')),true);child.emit('close',1);await rejected;
  assert.equal(fs.existsSync(path.join(f.config.dataVersion.workspace,'.lingtu-data-version-staging','command-lease.json')),false);
});
