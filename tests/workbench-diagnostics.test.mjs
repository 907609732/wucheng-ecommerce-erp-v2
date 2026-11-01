import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDiagnostics,safeLogText} from '../desktop/launcher/diagnostics.mjs';
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
async function fixture(options={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingtu-diagnostics-'));const services={config:id=>({dataDir:path.join(root,'data',id)}),status:async()=>[{extension:'purchase',status:'stopped',version:'1',busy:false}]};return {root,diagnostics:createDiagnostics({profile:root,services,version:'test',...options})};}
test('common credentials are removed before quoted JSON and header sanitization',()=>{
 const text=safeLogText('password="secret with spaces"\n{"token":"a-secret with spaces", "phone":"13812345678"}\nCookie: sid=one; other=two\nAuthorization: Bearer three\nhttps://example.com/a?token=four\nC:\\Users\\Alice\\secret.txt\nalice@example.com');
 for(const secret of ['secret with spaces','a-secret','sid=one','other=two','Bearer three','token=four','Alice','alice@example.com','13812345678'])assert.ok(!text.includes(secret),secret);
 assert.ok(text.includes('[REDACTED]'));
});
test('real file persistence, filtering and bounded rotation do not expose credentials',async()=>{
 const {root,diagnostics:d}=await fixture({maxBytes:1024});
 for(let i=0;i<80;i++)d.write(i===79?'error':'info','workbench','case-'+i+' password="never expose" '+'x'.repeat(90));await pause();await pause();
 const result=await d.read({level:'error',query:'case-79'});assert.equal(result.entries.length,1);assert.ok(!result.entries[0].text.includes('never expose'));
 assert.equal(await fs.stat(path.join(d.directory,'workbench.old.log')).then(()=>true),true);
 const files=await fs.readdir(d.directory);assert.equal(files.length,2);assert.equal((await d.read({query:'does not exist'})).entries.length,0);
 await assert.rejects(d.read({source:'../../secrets.bin'}),/未知/);await assert.rejects(d.read({level:'arbitrary'}),/级别/);
 const report=await d.bundle();assert.equal(report.services[0].id,'purchase');assert.equal(JSON.stringify(report).includes(root),false);
});
test('client diagnostics never inspect local business stores or service configuration',async()=>{
 const {diagnostics:d}=await fixture({mode:()=> 'client',services:{config(){throw Error('must not read local book')},status(){throw Error('must not inspect local services')}}});
 const result=await d.read({source:'purchase'});assert.equal(result.entries.length,0);assert.deepEqual((await d.bundle()).services,[]);
});
test('large legacy logs are tailed and an incomplete first line is discarded',async()=>{
 const {root,diagnostics:d}=await fixture();const directory=path.join(root,'data/purchase');await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(path.join(directory,'integration-service.log'),'secret-prefix-'+ 's'.repeat(300000));assert.equal((await d.read({source:'purchase'})).entries.length,0);
 await fs.appendFile(path.join(directory,'integration-service.log'),'\n[2026-01-01 00:00:00] ERROR known-case\n');const r=await d.read({source:'purchase',level:'error'});assert.equal(r.entries.length,1);assert.equal(r.truncated,true);
});
test('write failures are visible and cannot crash business operations',async()=>{
 const {root}=await fixture();const blocked=path.join(root,'blocked');await fs.writeFile(blocked,'not a directory');
 const d=createDiagnostics({profile:blocked,services:{config:()=>({dataDir:root}),status:async()=>[]},version:'test'});assert.doesNotThrow(()=>d.write('error','workbench','test'));await pause();assert.match(d.storageError,/写入|写入失败/);
});
