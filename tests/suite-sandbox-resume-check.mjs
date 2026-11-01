import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
assert.equal(os.userInfo().username,'WDAGUtilityAccount');
const state=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const marker=JSON.parse(fs.readFileSync(path.join(os.homedir(),'Documents/LingtuWorkbench/workbench-location.json'),'utf8'));
assert.equal(path.resolve(marker.profile).toLowerCase(),path.resolve(state.profile).toLowerCase());
assert.equal(path.resolve(marker.registryFile).toLowerCase(),path.resolve(state.registryFile).toLowerCase());
assert.equal(JSON.parse(fs.readFileSync(path.join(state.profile,'launcher-settings.json'),'utf8')).startAtLogin,true);
const receipt=JSON.parse(fs.readFileSync(path.join(state.profile,'suite-current.json'),'utf8'));
assert.equal(receipt.version,state.version);assert.equal(receipt.fingerprint,state.fingerprint);
for(const row of state.books){
 assert(path.resolve(row.database).toLowerCase().startsWith(path.resolve(os.homedir(),'Documents/LingtuWorkbench/Data').toLowerCase()+path.sep));
 const db=new DatabaseSync(row.database,{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT value FROM acceptance_sentinel WHERE id=?').get('offline-fixture').value,'synthetic-'+row.id);}finally{db.close();}
 assert.equal(createHash('sha256').update(fs.readFileSync(row.asset)).digest('hex'),row.sha256);
}
console.log(JSON.stringify({ok:true,canonicalBinding:true,books:state.books.length,originalFiles:state.books.length,receiptPreserved:true}));
