import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {prepareServe,enableServe,rollbackServe} from '../desktop/workbench-client/tailscale-serve.mjs';
test('Serve adds only private 8443, preserves phone443 and rolls back only the managed port',()=>{
 const origin='https://host.tail.ts.net:8443',backupRoot=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-network-'));
 const before={TCP:{443:{HTTPS:true}},Web:{'host.tail.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:17869'}}}}};let current=structuredClone(before);const commands=[];
 const run=args=>{commands.push(args);if(args.includes('status'))return JSON.stringify(current);if(args.includes('off')){delete current.Web['host.tail.ts.net:8443'];delete current.TCP[8443];}else{current.TCP[8443]={HTTPS:true};current.Web['host.tail.ts.net:8443']={Handlers:{'/':{Proxy:'http://127.0.0.1:17330'}}};}return '';};
 const result=enableServe({origin,backupRoot,run});assert.deepEqual(current.Web['host.tail.ts.net:443'],before.Web['host.tail.ts.net:443']);assert.equal(current.AllowFunnel,undefined);assert.deepEqual(result.difference.preserve,['host.tail.ts.net:443']);
 assert.equal(prepareServe({origin,backupRoot,run}).alreadyEnabled,true);rollbackServe({origin,beforeFile:result.file,run});assert.deepEqual(current,before);assert(!commands.flat().includes('reset'));assert(!commands.flat().includes('funnel'));
});
test('Serve refuses conflicting private service or public Funnel without modifying configuration',()=>{
 const origin='https://host.tail.ts.net:8443',backupRoot=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-network-'));
 for(const current of [{Web:{'host.tail.ts.net:8443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}},{AllowFunnel:{'host.tail.ts.net:8443':true}}]){
  let calls=0;assert.throws(()=>enableServe({origin,backupRoot,run:()=>{calls++;return JSON.stringify(current);}}));assert.equal(calls,1);
 }
});
