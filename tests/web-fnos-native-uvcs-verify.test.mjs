import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {uvcsFixture} from './fnos-native-uvcs-fixture.mjs';
import {prepareNativeUvcs,metadataFingerprint,fingerprint} from '../server/fnos-native/uvcs-registration.mjs';
const api=await import('../server/fnos-native/verify-uvcs.mjs').catch(()=>({}));
async function ready(t){
 const f=uvcsFixture(t);f.c.native.uvcsSourceMetadataHash=metadataFingerprint(f.workspace);fs.writeFileSync(f.configFile,JSON.stringify(f.c));
 const db=new DatabaseSync(path.join(f.c.dataVersion.dir,'queue.sqlite'));db.exec('CREATE TABLE data_version_queue(id TEXT PRIMARY KEY,status TEXT,changeset TEXT,actor TEXT)');db.prepare('INSERT INTO data_version_queue VALUES(?,?,?,?)').run('event-one','submitted','cs:7','secret actor');db.prepare('INSERT INTO data_version_queue VALUES(?,?,?,?)').run('event-two','submitted','cs:8','secret actor');db.close();
 await prepareNativeUvcs(f.c);return f;
}
const protectedBytes=f=>({home:fingerprint(f.home),version:fingerprint(f.c.dataVersion.dir),data:fingerprint(path.join(f.root,'data')),config:fs.readFileSync(f.configFile,'utf8')});
test('readonly verification checks every submitted event without changing client or ledger bytes',async t=>{
 assert.equal(typeof api.verifyNativeUvcs,'function','native read-only verifier required');const f=await ready(t),before=protectedBytes(f);
 const result=await api.verifyNativeUvcs(f.configFile);assert.equal(result.ok,true);assert.equal(result.submittedCount,2);assert.deepEqual(result.matches,[{id:'event-one',changeset:'cs:7'},{id:'event-two',changeset:'cs:8'}]);assert.deepEqual(protectedBytes(f),before);
 const reports=fs.readdirSync(path.join(f.c.stateDir,'diagnostics'));assert.equal(reports.length,1);const report=fs.readFileSync(path.join(f.c.stateDir,'diagnostics',reports[0]),'utf8');for(const secret of ['secret actor',f.root,'repo@organization','stdout','stderr'])assert.equal(report.includes(secret),false);
 if(process.platform!=='win32')assert.equal(fs.statSync(path.join(f.c.stateDir,'diagnostics',reports[0])).mode&0o777,0o600);
});
for(const mode of ['wrong-repo','missing','wrong-cs','duplicate','error','timeout','mutate-home'])test('readonly verifier fails closed with sanitized report: '+mode,async t=>{
 assert.equal(typeof api.verifyNativeUvcs,'function');const f=await ready(t);fs.writeFileSync(path.join(f.home,'mode'),mode);const before=protectedBytes(f);
 const result=await api.verifyNativeUvcs(f.configFile,{timeoutMs:500});assert.equal(result.ok,false);assert.match(result.code,/^UVCS_/);
 if(mode==='mutate-home')assert.equal(result.code,'UVCS_READONLY_STATE_CHANGED');else assert.deepEqual(protectedBytes(f),before);
 const report=JSON.stringify(result);assert.equal(report.includes(f.root),false);assert.equal(report.includes('secret actor'),false);
});
for(const guard of ['disabled','unprepared','unregistered','running','lease','invalid-event','pending-queue'])test('readonly guard refuses before side-effecting discovery: '+guard,async t=>{
 assert.equal(typeof api.verifyNativeUvcs,'function');const f=await ready(t);
 if(guard==='disabled'){f.c.dataVersion.enabled=false;fs.writeFileSync(f.configFile,JSON.stringify(f.c));}
 if(guard==='unprepared')fs.unlinkSync(path.join(f.c.stateDir,'native-uvcs-registration.json'));
 if(guard==='unregistered')fs.unlinkSync(path.join(f.home,'registered'));
 if(guard==='running')fs.writeFileSync(path.join(f.c.stateDir,'native-supervisor.json'),JSON.stringify({pid:process.pid}));
 if(guard==='lease'){fs.mkdirSync(path.join(f.workspace,'.lingtu-data-version-staging'));fs.writeFileSync(path.join(f.workspace,'.lingtu-data-version-staging','command-lease.json'),'{}');}
 if(['invalid-event','pending-queue'].includes(guard)){const db=new DatabaseSync(path.join(f.c.dataVersion.dir,'queue.sqlite'));if(guard==='invalid-event')db.prepare('UPDATE data_version_queue SET id=? WHERE id=?').run("bad'id",'event-one');else db.exec("UPDATE data_version_queue SET status='pending' WHERE id='event-one'");db.close();}
 const before=protectedBytes(f),log=fs.readFileSync(path.join(f.root,'commands.log'),'utf8');const result=await api.verifyNativeUvcs(f.configFile);assert.equal(result.ok,false);assert.deepEqual(protectedBytes(f),before);
 const later=fs.readFileSync(path.join(f.root,'commands.log'),'utf8').slice(log.length);assert.equal(later.includes('showselector'),false);assert.equal(later.includes('fileinfo'),false);
});
test('readonly cancellation confirms owned child exit and preserves queue',async t=>{
 assert.equal(typeof api.verifyNativeUvcs,'function');const f=await ready(t);fs.writeFileSync(path.join(f.home,'mode'),'timeout');const before=protectedBytes(f),controller=new AbortController();const timer=setTimeout(()=>controller.abort(),150);try{const result=await api.verifyNativeUvcs(f.configFile,{signal:controller.signal});assert.equal(result.code,'UVCS_CANCELLED');assert.deepEqual(protectedBytes(f),before);}finally{clearTimeout(timer);}
});

for(const missing of ['queue','home','cm'])test('readonly verifier refuses missing required state without recreating it: '+missing,async t=>{
 const f=await ready(t);if(missing==='queue')fs.unlinkSync(path.join(f.c.dataVersion.dir,'queue.sqlite'));if(missing==='home')fs.renameSync(f.home,f.home+'-saved');if(missing==='cm'){f.c.dataVersion.cmPath=path.join(f.root,'missing-cm');fs.writeFileSync(f.configFile,JSON.stringify(f.c));}
 const config=fs.readFileSync(f.configFile,'utf8'),log=fs.readFileSync(path.join(f.root,'commands.log'),'utf8');const result=await api.verifyNativeUvcs(f.configFile);assert.equal(result.ok,false);assert.equal(fs.readFileSync(f.configFile,'utf8'),config);assert.equal(fs.readFileSync(path.join(f.root,'commands.log'),'utf8'),log);
});
test('readonly verifier rejects linked HOME before commands',async t=>{
 const f=await ready(t);fs.renameSync(f.home,f.home+'-saved');try{fs.symlinkSync(f.home+'-saved',f.home,'junction');}catch(e){if(e.code==='EPERM'){t.skip('symlink privilege unavailable');return;}throw e;}
 const log=fs.readFileSync(path.join(f.root,'commands.log'),'utf8');const result=await api.verifyNativeUvcs(f.configFile);assert.equal(result.ok,false);assert.equal(fs.readFileSync(path.join(f.root,'commands.log'),'utf8'),log);
});
for(const name of ['native-lifecycle.sqlite','native-ownership.sqlite'])test('readonly verifier holds existing lifecycle coordination: '+name,async t=>{
 const f=await ready(t),lock=new DatabaseSync(path.join(f.c.stateDir,name));lock.exec('BEGIN EXCLUSIVE');try{const result=await api.verifyNativeUvcs(f.configFile);assert.equal(result.ok,false);}finally{lock.close();}
});
test('readonly overall budget and timeout leave no created command alive',async t=>{
 const f=await ready(t);fs.writeFileSync(path.join(f.home,'mode'),'timeout');const start=Date.now();const result=await api.verifyNativeUvcs(f.configFile,{totalMs:300});assert.equal(result.code,'UVCS_TIMEOUT');assert.ok(Date.now()-start<5500);
 for(const pid of fs.readFileSync(path.join(f.root,'children.log'),'utf8').trim().split('\n').map(Number))assert.throws(()=>process.kill(pid,0));
});
