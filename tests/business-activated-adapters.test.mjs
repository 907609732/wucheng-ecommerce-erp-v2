import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadActivatedBusinessAdapter} from '../desktop/business-interface/activated-adapters.mjs';
test('real adapters resolve dependencies from activated roots outside installation apps',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'activated-adapter-'));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true,maxRetries:5}));
 fs.mkdirSync(path.join(temp,'programs'),{recursive:true});fs.symlinkSync(path.resolve('node_modules'),path.join(temp,'programs','node_modules'),'junction');
 const installed=path.join(temp,'installation','apps');fs.mkdirSync(installed,{recursive:true});
 for(const id of ['purchase','sales','overview']){
  fs.mkdirSync(path.join(installed,id),{recursive:true});
  const source=path.resolve('apps',id),root=path.join(temp,'programs',id);fs.mkdirSync(root,{recursive:true});
  fs.cpSync(path.join(source,'lib'),path.join(root,'lib'),{recursive:true});
  fs.cpSync(path.join(source,'public'),path.join(root,'public'),{recursive:true});
  fs.copyFileSync(path.join(source,'package.json'),path.join(root,'package.json'));
  fs.symlinkSync(path.join(source,'node_modules'),path.join(root,'node_modules'),'junction');
  const adapter=await loadActivatedBusinessAdapter(id,{config:actual=>{assert.equal(actual,id);return {root};}},{request:async()=>({ok:true})});
  assert.equal(adapter.id,id);assert.ok(adapter.capabilities.length>0);assert.equal(fs.existsSync(path.join(installed,id,'node_modules')),false);
 }
 await assert.rejects(loadActivatedBusinessAdapter('../../unexpected',{config:()=>{throw Error('must not resolve');}},{}),/Unsupported/);
});
