import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import asar from '@electron/asar';
import {createHash} from 'node:crypto';
const archive='dist/launcher-release/win-unpacked/resources/app.asar';
const entries=asar.listPackage(archive).map(n=>n.replaceAll('\\','/').replace(/^\//,''));
for(const rel of ['desktop/launcher/index.html','desktop/launcher/opening.css']){
  assert.doesNotMatch(asar.extractFile(archive,path.normalize(rel)).toString(),/openingSpinner|openingSpin|rotate\(360deg\)/,'Packaged launcher must not restore old rotating Loading');
}
assert.match(asar.extractFile(archive,path.normalize('desktop/launcher/index.html')).toString(),/lt-loading__progress/,'Packaged launcher includes shared progress Loading');
const forbidden=entries.filter(n=>/^(core|data|workspace|desktop\/renderer|desktop\/invoice-module)(\/|$)|\.(sqlite|pem|key|pfx)$/i.test(n));
assert.deepEqual(forbidden,[]);
assert(entries.includes('desktop/workbench-migration/verify-pending-entry.mjs'),'Internal migration verifier must be shipped with the launcher');
const changed=[];
const digest=x=>createHash('sha256').update(x).digest('hex');
for(const rel of entries){
  if(rel.startsWith('desktop/')&&fs.existsSync(rel)&&fs.statSync(rel).isFile()){
    // The suite build intentionally replaces the historical online catalog with
    // the exact signed full-product catalog shipped alongside the executable.
    const expected=rel==='desktop/launcher/catalog.json'?'dist/launcher-release/win-unpacked/resources/bundled-suite/catalog.json':rel;
    if(digest(asar.extractFile(archive,path.normalize(rel)))!==digest(fs.readFileSync(expected)))changed.push(rel);
  }
}
assert.deepEqual(changed,[],'Launcher source changed after packaging');
const secrets=JSON.parse(fs.readFileSync('dist/module-verification/launcher-secrets.json','utf8'));
assert.deepEqual(secrets,[]);
console.log(JSON.stringify({ok:true,pureLauncher:true,noSourceDrift:true,noDetectedSecrets:true}));
