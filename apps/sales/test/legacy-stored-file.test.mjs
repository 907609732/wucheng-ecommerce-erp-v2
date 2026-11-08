import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp,createSessionFetch} from './helpers.mjs';
import {previewImport} from '../lib/importer.mjs';
import {hash} from '../lib/util.mjs';
test('legacy original HTTP downloads, platform evidence and import preview read the actual portable file',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-legacy-path-')),{app,store}=createApp({dataDir:dir,port:18993,demo:true});
 const server=app.listen(18993,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const content=Buffer.from('date,kind,amount,currency,external_id\n2026-09-01,sale,2,CNY,legacy-sale\n');fs.writeFileSync(path.join(dir,'originals','legacy.csv'),content);
 const shop=store.shops()[0],ctx={month:'2026-09',dataset:'ledger',shop_id:shop.id,header_row:1};
 store.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)','legacy',shop.id,'ledger','legacy.csv',hash(content),'originals\\legacy.csv','2026-09-01','staged',JSON.stringify(ctx),'{}');
 store.run('INSERT INTO platform_references VALUES(?,?,?,?,?)','legacy-evidence',shop.id,'2026-09',JSON.stringify({evidence_path:'originals\\legacy.csv'}),'2026-09-01');
 const base='http://127.0.0.1:18993',request=await createSessionFetch(base,'boss');
 for(const route of ['/api/imports/legacy/original','/api/pdd/references/legacy-evidence/evidence']){const response=await request(base+route);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),content);}
 const preview=await previewImport(store,'legacy',{mapping:{date:0,kind:1,amount:2,currency:3,external_id:4},source:'synthetic original'});assert.equal(preview.summary.total,1);
 assert.equal(store.get('SELECT original_path FROM imports WHERE id=?','legacy').original_path,'originals\\legacy.csv');
 // The evidence boundary must keep its originals-only policy.
 fs.writeFileSync(path.join(dir,'reports','private.csv'),'private report');store.run('INSERT INTO platform_references VALUES(?,?,?,?,?)','invalid-evidence',shop.id,'2026-10',JSON.stringify({evidence_path:'reports\\private.csv'}),'2026-10-01');
 assert.equal((await request(base+'/api/pdd/references/invalid-evidence/evidence')).status,400);
});
