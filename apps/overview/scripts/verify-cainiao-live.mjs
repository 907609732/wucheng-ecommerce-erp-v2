import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {loadSources} from '../lib/sources.mjs';
import {inspectBill,reconcile,resolveArchive} from '../lib/cainiao-files.mjs';
import {restoreBackup} from '../lib/files.mjs';

// Acceptance reads actual archived exports; it never submits platform tasks or posts expenses.
const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:17890';
const jid=process.argv[2];assert.match(jid||'',/^[a-f0-9-]{36}$/,'请提供已完成任务编号');
const get=async p=>{const r=await fetch(base+p);assert.ok(r.ok,`${p}: ${r.status}`);return r.json();};
const job=await get('/api/cainiao/download-jobs/'+jid);
assert.equal(job.status,'completed','真实任务尚未完成，不可验收');
assert.ok(job.items.every(i=>i.status==='completed'&&i.verification?.verified),'每种报表须有校验通过的原件');
const results=[];
for(const item of job.items){
 for(const fid of item.fileIds){
  const f=job.files.find(f=>f.id===fid);assert.ok(f);
  const bytes=fs.readFileSync(resolveArchive(path.join(root,'data'),f.path));
  assert.equal(bytes.length,f.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256);
  const check=reconcile(item.type,await inspectBill(bytes,f.filename),item.expected);assert.ok(check.verified,check.reason);
  const served=await fetch(base+f.url);assert.ok(served.ok);assert.equal(createHash('sha256').update(Buffer.from(await served.arrayBuffer())).digest('hex'),f.sha256);
  results.push({type:item.type,month:item.month,platformTask:item.remoteTask?.id,filename:f.filename,path:f.path,bytes:f.bytes,sha256:f.sha256,verification:check});
 }
}
const before=JSON.parse(fs.readFileSync(path.join(root,'test-output/cainiao-live-before.json'),'utf8'));
const db=new DatabaseSync(path.join(root,'data/overview.sqlite'),{readOnly:true});
const financial=Object.fromEntries(Object.keys(before.financial).map(t=>{const rows=db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all();return [t,{count:rows.length,hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}];}));db.close();
assert.deepEqual(financial,before.financial,'财务记录已变化，请人工核对变化来源');
const sources=loadSources();assert.equal(sources.errors.length,0);assert.deepEqual(sources.sourceVersions,before.sourceVersions,'源账本已变化，请核对变化来源');
const boot=await get('/api/bootstrap');
const backupResponse=await fetch(base+'/api/backups',{method:'POST',headers:{'Content-Type':'application/json','X-Overview-Token':boot.token},body:'{}'});assert.ok(backupResponse.ok);const backup=await backupResponse.json();
const restored=await restoreBackup(fs.readFileSync(path.join(root,'data/backups',backup.name)),path.join(root,'data/restored'));
const restoredDb=new DatabaseSync(path.join(restored.path,'overview.sqlite'),{readOnly:true});
assert.equal(JSON.parse(restoredDb.prepare('SELECT payload FROM cainiao_jobs WHERE id=?').get(jid).payload).status,'completed');
for(const f of job.files){const row=restoredDb.prepare('SELECT * FROM cainiao_files WHERE id=?').get(f.id);assert.ok(row);assert.equal(createHash('sha256').update(fs.readFileSync(resolveArchive(restored.path,row.path))).digest('hex'),f.sha256);}restoredDb.close();
const result={verifiedAt:new Date().toISOString(),method:'独立本机程序通过官方 Playwright MCP 扩展实际下载',jobId:jid,results,financialUnchanged:true,sourceLogicalHashesUnchanged:true,backup:backup.name,restoredPath:restored.path,multiMonthReady:(await get('/api/cainiao/connection')).multiMonthReady};
fs.writeFileSync(path.join(root,'test-output/cainiao-live-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({jobId:jid,files:results.length,financialUnchanged:true,backup:backup.name,restoredPath:restored.path,multiMonthReady:result.multiMonthReady},null,2));
