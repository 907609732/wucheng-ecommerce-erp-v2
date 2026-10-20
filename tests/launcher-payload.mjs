import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import asar from '@electron/asar';
import {createHash} from 'node:crypto';
const archive='dist/launcher-release/win-unpacked/resources/app.asar';
const entries=asar.listPackage(archive).map(n=>n.replaceAll('\\','/').replace(/^\//,''));
const forbidden=entries.filter(n=>/^(core|data|workspace|desktop\/renderer|desktop\/invoice-module)(\/|$)|\.(sqlite|pem|key|pfx)$/i.test(n));
assert.deepEqual(forbidden,[]);
const changed=[];
const digest=x=>createHash('sha256').update(x).digest('hex');
for(const rel of entries){
  if(rel.startsWith('desktop/')&&fs.existsSync(rel)&&fs.statSync(rel).isFile()){
    if(digest(asar.extractFile(archive,path.normalize(rel)))!==digest(fs.readFileSync(rel)))changed.push(rel);
  }
}
assert.deepEqual(changed,[],'Launcher source changed after packaging');
const secrets=JSON.parse(fs.readFileSync('dist/module-verification/launcher-secrets.json','utf8'));
assert.deepEqual(secrets,[]);
console.log(JSON.stringify({ok:true,pureLauncher:true,noSourceDrift:true,noDetectedSecrets:true}));
