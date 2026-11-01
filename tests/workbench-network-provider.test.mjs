import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ConnectionStore} from '../desktop/workbench-client/connection.mjs';
import {WorkbenchTransport} from '../desktop/workbench-client/transport.mjs';
import {ensureTailnetSessionDirect, forgetDirectTailnetSession} from '../desktop/workbench-client/tailnet-session.mjs';
import {prepareEmbeddedSession, resetEmbeddedSession} from '../desktop/workbench-client/embedded-session.mjs';

const originA='https://host-a.example.ts.net:8443',originB='https://host-b.example.ts.net:8443';
const identity={serverId:'server-a',dataSetId:'company-a',userId:'member-a'};
const sessionBody={protocolVersion:1,serverId:identity.serverId,dataSetId:identity.dataSetId,actor:{id:identity.userId},csrfToken:'csrf-a'};
const response=(body,{status=200,cookie}={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...(cookie?{'Set-Cookie':'__Host-workbench-session='+cookie+'; Secure; HttpOnly; Path=/'}:{})}});
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};
function isolated(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-provider-generation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const connection=new ConnectionStore(root);connection.configure({mode:'client',serverUrl:originA,networkProvider:'system'});return {root,connection};}

test('choosing an embedded connection retains account, ledger pins and migration restrictions',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-provider-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new ConnectionStore(root),serverUrl='https://host.example.ts.net:8443';
  store.configure({mode:'client',serverUrl},[{module:'purchase',present:true,records:3}]);
  store.bind({serverId:'server',dataSetId:'dataset',userId:'member'});
  store.bindModule('purchase','purchase-dataset');
  const old=store.read(),original=fs.readFileSync(store.file);
  assert.equal(old.networkProvider,undefined);
  assert.deepEqual(fs.readFileSync(store.file),original);
  store.configure({mode:'client',serverUrl,networkProvider:'embedded'},old.migration.inventory);
  const next=store.read();
  assert.equal(next.networkProvider,'embedded');
  assert.equal(next.clientId,old.clientId);
  assert.deepEqual(next.pins,old.pins);
  assert.deepEqual(next.modulePins,old.modulePins);
  assert.deepEqual(next.migration,old.migration);
  assert.equal(store.canWrite(),false);
  assert.throws(()=>store.bind({serverId:'server',dataSetId:'dataset',userId:'other'}),e=>e.code==='DATASET_CHANGED');
  assert.throws(()=>new ConnectionStore(root).cacheScope('purchase'));
  store.bind({serverId:'server',dataSetId:'dataset',userId:'member'});
  assert.equal(store.cacheScope('purchase').userId,'member');
  store.lockCache();
  assert.throws(()=>new ConnectionStore(root).cacheScope('purchase'));
  store.bind({serverId:'server',dataSetId:'dataset',userId:'member'});
  store.configure({mode:'client',serverUrl,networkProvider:'system'},old.migration.inventory);
  assert.deepEqual(store.read().pins,old.pins);
  assert.equal(store.canWrite(),false);
});

test('unknown network providers cannot mutate a saved connection or trigger a fallback',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-provider-invalid-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new ConnectionStore(root),serverUrl='https://host.example.ts.net:8443';
  store.configure({mode:'client',serverUrl,networkProvider:'embedded'});
  const original=fs.readFileSync(store.file);
  assert.throws(()=>store.configure({mode:'client',serverUrl,networkProvider:'auto-public'}));
  assert.deepEqual(fs.readFileSync(store.file),original);
  fs.writeFileSync(store.file,JSON.stringify({...store.read(),networkProvider:'auto-public'}));
  assert.throws(()=>store.read());
});

for(const [name,change] of [
  ['a different server origin',connection=>connection.configure({mode:'client',serverUrl:originB,networkProvider:'embedded'})],
  ['a provider change on the same origin',connection=>connection.configure({mode:'client',serverUrl:originA,networkProvider:'embedded'})],
  ['an identical saved configuration with a new generation',connection=>connection.configure({mode:'client',serverUrl:originA,networkProvider:'system'})],
  ['an origin round trip back to the same URL',connection=>{connection.configure({mode:'client',serverUrl:originB});connection.configure({mode:'client',serverUrl:originA});}],
  ['a provider round trip back to the same policy',connection=>{connection.configure({mode:'client',serverUrl:originA,networkProvider:'embedded'});connection.configure({mode:'client',serverUrl:originA,networkProvider:'system'});}]
]) test('a delayed session response cannot pin old identity after '+name,async t=>{
  const {connection}=isolated(t),started=deferred(),release=deferred();let calls=0;
  const transport=new WorkbenchTransport({connection,fetchImpl:async()=>{calls++;started.resolve();await release.promise;return response(sessionBody,{cookie:'old-cookie'});}});
  const pending=transport.connect(),rejected=assert.rejects(pending,{code:'CONNECTION_CHANGED'});
  await started.promise;const before=connection.read().configurationId;change(connection);assert.notEqual(connection.read().configurationId,before);
  const saved=fs.readFileSync(connection.file);release.resolve();await rejected;
  assert.deepEqual(fs.readFileSync(connection.file),saved,'discarding an old response must not rewrite pins/cache locks');
  assert.equal(connection.read().pins,null);assert.equal(transport.identity,null);
  await assert.rejects(transport.request('/modules'),{code:'CONNECTION_CHANGED'});assert.equal(calls,1,'the stale transport must not make another request');
});

test('configuration changes while JSON is being decoded also discard the old session response',async t=>{
  const {connection}=isolated(t),reading=deferred(),release=deferred();
  const transport=new WorkbenchTransport({connection,fetchImpl:async()=>({ok:true,status:200,headers:new Headers({'Content-Type':'application/json','Set-Cookie':'__Host-workbench-session=old; Secure; HttpOnly; Path=/'}),async json(){reading.resolve();await release.promise;return sessionBody;}})});
  const rejected=assert.rejects(transport.connect(),{code:'CONNECTION_CHANGED'});await reading.promise;
  connection.configure({mode:'client',serverUrl:originA,networkProvider:'embedded'});const saved=fs.readFileSync(connection.file);
  release.resolve();await rejected;assert.deepEqual(fs.readFileSync(connection.file),saved);assert.equal(transport.identity,null);
});

test('an old Transport never sends its cookie to a new server and a replacement starts with an empty jar',async t=>{
  const {connection}=isolated(t),calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,cookie:options.headers.Cookie||''});return url.endsWith('/session')?response({...sessionBody,...(url.startsWith(originB)?{serverId:'server-b',dataSetId:'company-b',actor:{id:'member-b'}}:{})},{cookie:url.startsWith(originA)?'cookie-a':'cookie-b'}):response({modules:[]});};
  const old=new WorkbenchTransport({connection,fetchImpl});await old.connect();await old.modules();
  assert.equal(calls.at(-1).cookie,'__Host-workbench-session=cookie-a');
  connection.configure({mode:'client',serverUrl:originB,networkProvider:'embedded'});
  const count=calls.length;await assert.rejects(old.modules(),{code:'CONNECTION_CHANGED'});await assert.rejects(old.request('/session'),{code:'CONNECTION_CHANGED'});assert.equal(calls.length,count);
  const replacement=new WorkbenchTransport({connection:new ConnectionStore(connection.root),fetchImpl});await replacement.connect();await replacement.modules();
  const onNew=calls.filter(call=>call.url.startsWith(originB));assert.equal(onNew.length,2);assert.equal(onNew[0].cookie,'');assert.equal(onNew[1].cookie,'__Host-workbench-session=cookie-b');assert(!onNew.some(call=>call.cookie.includes('cookie-a')));
});

test('a pending old module connection cannot bind its ledger after a same-origin provider switch',async t=>{
  const {connection}=isolated(t),started=deferred(),release=deferred();
  const transport=new WorkbenchTransport({connection,fetchImpl:async url=>{if(url.endsWith('/session'))return response(sessionBody);if(url.endsWith('/connection')){started.resolve();await release.promise;return response({id:'purchase',dataSetId:'old-purchase',status:'running'});}throw Error('old module must not be queried');}});
  await transport.connect();const rejected=assert.rejects(transport.call('purchase','/api/orders'),{code:'CONNECTION_CHANGED'});await started.promise;
  connection.configure({mode:'client',serverUrl:originA,networkProvider:'embedded'});const saved=fs.readFileSync(connection.file);release.resolve();await rejected;
  assert.deepEqual(fs.readFileSync(connection.file),saved);assert.equal(connection.read().modulePins?.purchase,undefined);
});

test('module mismatch locks persist across stores, provider changes and global authentication; only its original ledger unlocks',t=>{
  const {root,connection}=isolated(t);connection.bind(identity);connection.bindModule('purchase','original-purchase');connection.bindModule('sales','original-sales');
  const original=connection.cacheScope('purchase'),expected=connection.read();
  assert.throws(()=>connection.bindModule('purchase','replacement-purchase'),{code:'DATASET_CHANGED'});
  let reopened=new ConnectionStore(root);assert.throws(()=>reopened.cacheScope('purchase'));assert.equal(reopened.cacheScope('sales').moduleDataSetId,'original-sales');
  assert.equal(reopened.read().modulePins.purchase,'original-purchase');reopened.bind(identity);assert.throws(()=>reopened.cacheScope('purchase'),'global identity verification cannot clear a module mismatch');
  reopened.configure({mode:'client',serverUrl:originA,networkProvider:'embedded'});reopened=new ConnectionStore(root);reopened.bind(identity);assert.throws(()=>reopened.cacheScope('purchase'));
  reopened.bindModule('sales','original-sales');assert.throws(()=>reopened.cacheScope('purchase'));assert.throws(()=>reopened.bindModule('purchase',''),{code:'MODULE_IDENTITY_MISSING'});assert.throws(()=>reopened.cacheScope('purchase'));
  assert.throws(()=>reopened.bindModule('purchase','original-purchase',expected),{code:'CONNECTION_CHANGED'});assert.throws(()=>reopened.cacheScope('purchase'),'a stale confirmation cannot clear the lock');
  reopened.bindModule('purchase','original-purchase',reopened.read());assert.deepEqual(new ConnectionStore(root).cacheScope('purchase'),original);
});

for(const failureRoute of ['connection','business'])test('server-reported DATASET_CHANGED during '+failureRoute+' locks only that module persistently',async t=>{
  const {root,connection}=isolated(t);connection.bind(identity);connection.bindModule('purchase','original-purchase');connection.bindModule('sales','original-sales');let changed=false;
  const transport=new WorkbenchTransport({connection,fetchImpl:async url=>{
    if(url.endsWith('/session'))return response(sessionBody);
    if(url.endsWith('/connection'))return changed&&failureRoute==='connection'?response({code:'DATASET_CHANGED',error:'module changed'},{status:409}):response({id:'purchase',dataSetId:'original-purchase',status:'running'});
    return changed?response({code:'DATASET_CHANGED',error:'module changed'},{status:409}):response([]);
  }});
  await transport.connect();if(failureRoute==='business')await transport.call('purchase','/api/orders');changed=true;
  await assert.rejects(transport.call('purchase','/api/orders'),{code:'DATASET_CHANGED'});
  assert.equal(transport.identity,null);assert.equal(transport.cookies,'');assert.equal(transport.moduleConnections.size,0);
  const reopened=new ConnectionStore(root);assert.throws(()=>reopened.cacheScope('purchase'));assert.equal(reopened.cacheScope('sales').moduleDataSetId,'original-sales');
  reopened.bind(identity);assert.throws(()=>new ConnectionStore(root).cacheScope('purchase'),'logging in again cannot silently expose a mismatched module cache');
  reopened.bindModule('purchase','original-purchase',reopened.read());assert.equal(reopened.cacheScope('purchase').moduleDataSetId,'original-purchase');
});

test('server-reported global DATASET_CHANGED locks every module across restart and discards transport auth state',async t=>{
  const {root,connection}=isolated(t);connection.bind(identity);connection.bindModule('purchase','original-purchase');connection.bindModule('sales','original-sales');let changed=false;
  const transport=new WorkbenchTransport({connection,fetchImpl:async url=>{
    if(url.endsWith('/session'))return response(sessionBody,{cookie:'previous-cookie'});
    if(url.endsWith('/connection'))return response({id:'purchase',dataSetId:'original-purchase',status:'running'});
    if(changed)return response({code:'DATASET_CHANGED',error:'company identity changed'},{status:409});
    return response([]);
  }});
  await transport.connect();await transport.call('purchase','/api/orders');assert(transport.identity);assert(transport.cookies);assert.equal(transport.moduleConnections.size,1);
  changed=true;await assert.rejects(transport.request('/modules'),{code:'DATASET_CHANGED'});
  assert.equal(transport.identity,null);assert.equal(transport.cookies,'');assert.equal(transport.moduleConnections.size,0);
  const reopened=new ConnectionStore(root);assert.throws(()=>reopened.cacheScope('purchase'));assert.throws(()=>reopened.cacheScope('sales'));assert.equal(reopened.read().cacheLocked,true);
  await assert.rejects(transport.request('/session'),{code:'CONNECTION_CHANGED'});
});

test('an old delayed DATASET_CHANGED error must not lock the replacement server configuration',async t=>{
  const {connection}=isolated(t),started=deferred(),release=deferred();
  const transport=new WorkbenchTransport({connection,fetchImpl:async url=>{if(url.endsWith('/session'))return response(sessionBody);if(url.endsWith('/connection'))return response({id:'purchase',dataSetId:'original-purchase',status:'running'});started.resolve();await release.promise;return response({code:'DATASET_CHANGED'},{status:409});}});
  await transport.connect();const rejected=assert.rejects(transport.call('purchase','/api/orders'),{code:'CONNECTION_CHANGED'});await started.promise;
  connection.configure({mode:'client',serverUrl:originB,networkProvider:'embedded'});connection.bind({serverId:'server-b',dataSetId:'company-b',userId:'member-b'});connection.bindModule('purchase','new-purchase');const saved=fs.readFileSync(connection.file);
  release.resolve();await rejected;assert.deepEqual(fs.readFileSync(connection.file),saved);assert.equal(connection.cacheScope('purchase').moduleDataSetId,'new-purchase');
});

test('explicit provider reset forgets cached DIRECT and embedded decisions before the same Session is reused',async()=>{
  const configurations=[],ordinaryConfigurations=[];let healthRequests=0,clearAuth=0,closed=0;
  const session={async setProxy(value){configurations.push(value);},async clearAuthCache(){clearAuth++;},async closeAllConnections(){closed++;}},ordinary={async setProxy(value){ordinaryConfigurations.push(value);}};
  const broker={origin:originA,proxyURL:'http://127.0.0.1:31929',proxyUsername:'workbench',proxyPassword:'isolated-provider-secret',proxyRealm:'LingtuTailnet/'+'a'.repeat(32),brokerId:'same-isolated-broker'};
  const requestImpl=options=>{assert.equal(options.session,session);healthRequests++;const request=new EventEmitter();request.abort=()=>{};request.end=()=>queueMicrotask(()=>{const incoming=new EventEmitter();incoming.statusCode=200;incoming.headers={};request.emit('response',incoming);incoming.emit('data',Buffer.from(JSON.stringify({ok:true,service:'wucheng-workbench',protocolVersion:1})));incoming.emit('end');});return request;};
  await ensureTailnetSessionDirect(session);await ensureTailnetSessionDirect(session);assert.equal(configurations.length,1);
  forgetDirectTailnetSession(session);await resetEmbeddedSession(session);await prepareEmbeddedSession(session,broker,{requestImpl});assert.equal(configurations.at(-1).mode,'fixed_servers');
  forgetDirectTailnetSession(session);await resetEmbeddedSession(session);await ensureTailnetSessionDirect(session);assert.deepEqual(configurations.at(-1),{mode:'direct'});assert.equal(configurations.length,3,'the earlier resolved DIRECT promise must not be reused');
  forgetDirectTailnetSession(session);await resetEmbeddedSession(session);await prepareEmbeddedSession(session,broker,{requestImpl});assert.equal(healthRequests,2,'returning to the same broker requires an authenticated reinitialization after reset');
  assert.equal(configurations.at(-1).mode,'fixed_servers');assert.equal(configurations.length,4);assert.equal(clearAuth,5);assert.equal(closed,5);assert.deepEqual(ordinaryConfigurations,[]);assert.equal(typeof ordinary.setProxy,'function');
});

test('logout suspension persists across restart without losing original identities, module locks or migration restrictions',t=>{
  const {root,connection}=isolated(t);connection.configure({mode:'client',serverUrl:originA,networkProvider:'embedded'},[{module:'purchase',present:true,records:7}]);
  connection.bind(identity);connection.bindModule('purchase','original-purchase');connection.bindModule('sales','original-sales');
  assert.throws(()=>connection.bindModule('purchase','different-purchase'),{code:'DATASET_CHANGED'});
  const original=connection.read();connection.suspendNetwork();const suspended=new ConnectionStore(root).read();
  assert.equal(suspended.networkSuspended,true);assert.equal(suspended.cacheLocked,true);assert.notEqual(suspended.configurationId,original.configurationId);
  assert.deepEqual(suspended.pins,original.pins);assert.deepEqual(suspended.modulePins,original.modulePins);assert.deepEqual(suspended.moduleCacheLocks,original.moduleCacheLocks);assert.deepEqual(suspended.migration,original.migration);
  const reopened=new ConnectionStore(root);assert.throws(()=>reopened.cacheScope('purchase'));assert.throws(()=>reopened.cacheScope('sales'));assert.equal(reopened.canWrite(),false);
  const saved=fs.readFileSync(reopened.file);assert.throws(()=>reopened.bind(identity,reopened.read()),{code:'TAILNET_SUSPENDED'});assert.deepEqual(fs.readFileSync(reopened.file),saved,'a paused connection cannot be authenticated by a cached identity');
});

for(const resumeBeforeResponse of [false,true])test('a session response issued before logout cannot bind after '+(resumeBeforeResponse?'a suspend/resume round trip':'persistent suspension'),async t=>{
  const {root,connection}=isolated(t),started=deferred(),release=deferred();
  const transport=new WorkbenchTransport({connection,fetchImpl:async()=>{started.resolve();await release.promise;return response(sessionBody,{cookie:'stale-pre-logout-cookie'});}});
  const rejected=assert.rejects(transport.connect(),{code:'CONNECTION_CHANGED'});await started.promise;connection.suspendNetwork();
  if(resumeBeforeResponse)new ConnectionStore(root).resumeNetwork();
  const saved=fs.readFileSync(connection.file);release.resolve();await rejected;
  assert.deepEqual(fs.readFileSync(connection.file),saved);assert.equal(new ConnectionStore(root).read().pins,null);assert.equal(connection.read().cacheLocked,true);assert.equal(transport.identity,null);
});

test('a fresh Transport after restart cannot query, mutate, migrate or refresh cache while network is suspended',async t=>{
  const {root,connection}=isolated(t);connection.bind(identity);connection.bindModule('purchase','original-purchase');connection.suspendNetwork();let networkRequests=0;
  const transport=new WorkbenchTransport({connection:new ConnectionStore(root),fetchImpl:async()=>{networkRequests++;throw Error('A logged-out connection must not attempt any request');}});
  for(const call of [()=>transport.connect(),()=>transport.modules(),()=>transport.call('purchase','/api/orders'),()=>transport.snapshot('purchase'),()=>transport.request('/migrations/status'),()=>transport.request('/migrations/preview',{method:'POST',body:{},migration:true}),()=>transport.request('/modules/purchase/api/orders',{method:'POST',body:{}})]) await assert.rejects(call(),{code:'TAILNET_SUSPENDED'});
  assert.equal(networkRequests,0);assert.equal(transport.cookies,'');assert.equal(transport.identity,null);assert.equal(new ConnectionStore(root).read().networkSuspended,true);
});

test('resume grants permission to reconnect but keeps cached data locked until the original account is verified',async t=>{
  const {root,connection}=isolated(t);connection.bind(identity);connection.bindModule('purchase','original-purchase');const scope=connection.cacheScope('purchase');connection.suspendNetwork();
  const pausedTransport=new WorkbenchTransport({connection:new ConnectionStore(root),fetchImpl:async()=>{throw Error('Do not reuse a transport from the paused generation');}}),before=connection.read().configurationId;
  new ConnectionStore(root).resumeNetwork();const resumed=new ConnectionStore(root);assert.equal(resumed.read().networkSuspended,false);assert.notEqual(resumed.read().configurationId,before);assert.equal(resumed.read().cacheLocked,true);assert.throws(()=>resumed.cacheScope('purchase'));
  await assert.rejects(pausedTransport.connect(),{code:'CONNECTION_CHANGED'});
  const wrong=new WorkbenchTransport({connection:resumed,fetchImpl:async()=>response({...sessionBody,actor:{id:'other-member'}})});await assert.rejects(wrong.connect(),{code:'DATASET_CHANGED'});assert.throws(()=>new ConnectionStore(root).cacheScope('purchase'));
  const correct=new WorkbenchTransport({connection:new ConnectionStore(root),fetchImpl:async()=>response(sessionBody)});await correct.connect();assert.deepEqual(new ConnectionStore(root).cacheScope('purchase'),scope);
});

test('resume and global authentication do not clear a module mismatch inherited from before logout',async t=>{
  const {root,connection}=isolated(t);connection.bind(identity);connection.bindModule('purchase','original-purchase');connection.bindModule('sales','original-sales');assert.throws(()=>connection.bindModule('purchase','different-purchase'),{code:'DATASET_CHANGED'});
  connection.suspendNetwork();const reopened=new ConnectionStore(root);reopened.resumeNetwork();assert.throws(()=>reopened.cacheScope('sales'));
  const transport=new WorkbenchTransport({connection:reopened,fetchImpl:async()=>response(sessionBody)});await transport.connect();assert.equal(reopened.cacheScope('sales').moduleDataSetId,'original-sales');assert.throws(()=>new ConnectionStore(root).cacheScope('purchase'));
  reopened.bindModule('purchase','original-purchase',reopened.read());assert.equal(new ConnectionStore(root).cacheScope('purchase').moduleDataSetId,'original-purchase');
});

test('an explicit configuration save clears suspension while retaining the authentication fence and pending source inventory',t=>{
  const {root,connection}=isolated(t),inventory=[{module:'purchase',present:true,records:7}];connection.configure({mode:'client',serverUrl:originA,networkProvider:'embedded'},inventory);connection.bind(identity);connection.bindModule('purchase','original-purchase');
  connection.suspendNetwork();const paused=connection.read();new ConnectionStore(root).configure({mode:'client',serverUrl:originA,networkProvider:'embedded'},inventory);const saved=new ConnectionStore(root);
  assert.equal(saved.read().networkSuspended,false);assert.notEqual(saved.read().configurationId,paused.configurationId);assert.equal(saved.read().cacheLocked,true);assert.throws(()=>saved.cacheScope('purchase'));assert.deepEqual(saved.read().migration,paused.migration);assert.equal(saved.canWrite(),false);
  saved.bind(identity,saved.read());assert.equal(saved.cacheScope('purchase').moduleDataSetId,'original-purchase');assert.equal(saved.canWrite(),false,'re-authentication must not bypass pending data migration');
});
