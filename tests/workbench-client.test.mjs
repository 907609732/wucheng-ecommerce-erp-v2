import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ConnectionStore,serverAddress} from '../desktop/workbench-client/connection.mjs';
import {SnapshotCache} from '../desktop/workbench-client/cache.mjs';
import {WorkbenchTransport,RemoteServiceManager} from '../desktop/workbench-client/transport.mjs';
const fixture=()=>new ConnectionStore(fs.mkdtempSync(path.join(os.tmpdir(),'workbench-client-')));
test('connection accepts only private Tailscale HTTPS and detects existing ledgers before client writes',()=>{
  const config=fixture();assert.equal(config.read().mode,'standalone');
  for(const url of ['http://host.ts.net:8443','https://example.com','https://host.ts.net@evil.test','https://host.ts.net:443','https://host.ts.net:8443/path','https://host.ts.net:8443/?x=1'])assert.throws(()=>serverAddress(url));
  config.configure({mode:'client',serverUrl:'https://host.tail.ts.net:8443'},[{module:'purchase',present:true,records:1}]);assert.equal(config.canWrite(),false);
  config.bind({serverId:'server',dataSetId:'ledger',userId:'person'});assert.throws(()=>config.bind({serverId:'server',dataSetId:'new-ledger',userId:'person'}),e=>e.code==='DATASET_CHANGED');
  assert.throws(()=>config.archiveMigration({status:'completed',clientId:'other',sourceDigest:config.read().migration.sourceDigest,serverId:'server',dataSetId:'ledger'}));
});
test('offline snapshots are encrypted and isolated by person, server and data set',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-cache-')),key=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
  const cache=new SnapshotCache({root,encrypt:plain=>{const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce),body=Buffer.concat([cipher.update(plain),cipher.final()]);return Buffer.concat([cipher.getAuthTag(),body]);},decrypt:bytes=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,nonce);decipher.setAuthTag(bytes.subarray(0,16));return Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]).toString();}});
  const scope={userId:'alice',serverId:'server-a',dataSetId:'ledger-a'};await cache.put(scope,'purchase',{orders:[{note:'private-order'}]});
  assert.equal(fs.readFileSync(path.join(root,fs.readdirSync(root)[0])).includes(Buffer.from('private-order')),false);
  assert.equal((await cache.get(scope,'purchase')).data.orders[0].note,'private-order');
  assert.equal(await cache.get({...scope,userId:'bob'},'purchase'),null);assert.equal(await cache.get({...scope,dataSetId:'ledger-b'},'purchase'),null);
});
test('transport binds identity, session, CSRF and channel and never starts local business services',async()=>{
  const connection=fixture();connection.configure({mode:'client',serverUrl:'https://host.tail.ts.net:8443'},[]);const requests=[];
  const transport=new WorkbenchTransport({connection,channel:'mcp',fetchImpl:async(url,options)=>{
    requests.push({url,options});let body;
    if(url.endsWith('/session'))body={protocolVersion:1,serverId:'server',dataSetId:'ledger',actor:{id:'alice',login:'alice',role:'editor'},csrfToken:'csrf',sessionId:'session'};
    else if(url.endsWith('/modules'))body={modules:[{id:'purchase',status:'running',version:'1',dataSetId:'purchase-ledger'}]};else body={ok:true};
    if(url.endsWith('/modules/purchase/connection'))body={id:'purchase',status:'running',dataSetId:'purchase-ledger'};
    return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json',...(url.endsWith('/session')?{'Set-Cookie':'__Host-workbench-session=abc; Secure; HttpOnly; Path=/'}:{})}});
  }});
  await transport.connect();await transport.call('purchase','/api/integration/v1/edits',{method:'POST',body:{id:'draft'}});
  const last=requests.at(-1);assert.equal(last.options.headers['X-Workbench-CSRF'],'csrf');assert.equal(last.options.headers['X-Workbench-Channel'],'mcp');assert.equal(last.options.headers.Origin,'https://host.tail.ts.net:8443');assert.ok(last.options.headers['Idempotency-Key']);
  await assert.rejects(transport.call('purchase','/api/integration/v1/transfers/a/confirm',{method:'POST'}),e=>e.code==='UI_CONFIRMATION_REQUIRED');
  const manager=new RemoteServiceManager(transport),cap=await manager.ensure('purchase');assert.equal(cap.remote,true);assert.match(cap.url,/\/apps\/purchase$/);assert.throws(()=>manager.stop());assert.throws(()=>manager.config());
});
test('pending client migration blocks writes and unrecognized server identity fails closed',async()=>{
  const connection=fixture();connection.configure({mode:'client',serverUrl:'https://host.tail.ts.net:8443'},[{present:true,records:2}]);
  const transport=new WorkbenchTransport({connection,fetchImpl:async()=>{throw Error('should not send');}});
  await assert.rejects(transport.call('purchase','/api/orders',{method:'POST',body:{}}),e=>e.code==='MIGRATION_REQUIRED');
  const other=new WorkbenchTransport({connection,fetchImpl:async()=>new Response(JSON.stringify({protocolVersion:2}),{headers:{'Content-Type':'application/json'}})});
  await assert.rejects(other.connect(),e=>e.code==='VERSION_INCOMPATIBLE');
});

test('concurrent client queries share a cold module startup longer than the normal read timeout',{timeout:45000},async()=>{
 const connection=fixture();connection.configure({mode:'client',serverUrl:'https://host.tail.ts.net:8443'},[]);let starts=0,queries=0;
 const response=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 const transport=new WorkbenchTransport({connection,fetchImpl:async(url,{signal})=>{
  if(url.endsWith('/session'))return response({protocolVersion:1,serverId:'server',dataSetId:'ledger',actor:{id:'alice'},csrfToken:'csrf'});
  if(url.endsWith('/modules/purchase/connection')){
   starts++;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},31000);const aborted=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',aborted,{once:true});});
   return response({id:'purchase',dataSetId:'purchase-ledger',status:'running'});
  }
  queries++;return response({ok:true});
 }});
 const results=await Promise.all([transport.call('purchase','/api/orders'),transport.call('purchase','/api/orders')]);
 assert(results.every(r=>r.ok));assert.equal(starts,1);assert.equal(queries,2);assert.equal(connection.read().modulePins.purchase,'purchase-ledger');
});
