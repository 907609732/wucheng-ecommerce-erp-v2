import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createAgentStore} from '../desktop/agent-runtime/store.mjs';
import {createAgentSettings} from '../desktop/agent-runtime/settings.mjs';

function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-company-origin-')),store=createAgentStore(directory);let key='synthetic-original-provider-key';const secrets={has:()=>!!key,get:async()=>key,set:async(_name,value)=>{key=value;},delete:async()=>{key=null;}};t.after(async()=>{store.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return {settings:createAgentSettings(store,{secretStore:secrets}),actor:{id:'synthetic-member'},get key(){return key;}};}
test('changing provider origin without replacement or explicit clear preserves both configuration and key',async t=>{
  const f=fixture(t),before=f.settings.get();await assert.rejects(f.settings.save({company:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:''}},f.actor),{code:'COMPANY_API_KEY_ORIGIN_CHANGED'});assert.deepEqual(f.settings.get(),before);assert.equal(f.key,'synthetic-original-provider-key');
  const cleared=await f.settings.save({company:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash',clearApiKey:true}},f.actor);assert.equal(cleared.company.baseUrl,'https://api.deepseek.com');assert.equal(cleared.company.hasKey,false);await assert.rejects(f.settings.credentials(),{code:'COMPANY_API_REQUIRED'});
});
test('same-origin paths retain the key, while another origin requires and stores its own key',async t=>{
  const f=fixture(t);await f.settings.save({company:{baseUrl:'https://api.openai.com/custom/v1'}},f.actor);assert.equal(f.key,'synthetic-original-provider-key');
  await f.settings.save({company:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'synthetic-target-provider-key'}},f.actor);assert.equal(f.key,'synthetic-target-provider-key');const credentials=await f.settings.credentials();assert.equal(credentials.baseUrl,'https://api.deepseek.com');assert.equal(credentials.apiKey,'synthetic-target-provider-key');assert.equal(JSON.stringify(f.settings.get()).includes('synthetic-target-provider-key'),false);
});
