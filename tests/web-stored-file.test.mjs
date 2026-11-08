import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const api=await import('../shared/stored-file.mjs').catch(()=>({}));
test('portable stored original resolves actual bytes and rejects unsafe references',t=>{
 assert.equal(typeof api.resolveStoredFile,'function','shared checked stored-file reader is required');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'stored-file-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'originals'));fs.writeFileSync(path.join(root,'originals','sample.txt'),'exact original');
 for(const rel of ['originals/sample.txt','originals\\sample.txt']){const r=api.resolveStoredFile(root,rel,{folders:['originals']});assert.equal(r.relative,'originals/sample.txt');assert.equal(fs.readFileSync(r.file,'utf8'),'exact original');}
 for(const rel of ['/originals/sample.txt','C:\\originals\\sample.txt','C:originals/sample.txt','\\\\server\\share','\\originals\\sample.txt','originals/sample.txt:ads','originals/../sample.txt','originals/./sample.txt','originals//sample.txt','originals/missing.txt'])assert.throws(()=>api.resolveStoredFile(root,rel));
 assert.throws(()=>api.resolveStoredFile(root,'originals/sample.txt',{folders:['reports']}));
 fs.writeFileSync(path.join(root,'outside'),'escape');
 try{fs.symlinkSync(path.join(root,'outside'),path.join(root,'originals','link'));}catch(e){if(e.code==='EPERM'){t.diagnostic('Windows symlink privilege unavailable; Linux CI covers symlink refusal');return;}throw e;}
 assert.throws(()=>api.resolveStoredFile(root,'originals/link'));
});
