import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {getWorkbenchLocation,defaultIntegrationRegistryPath,workbenchLocationFile} from '../desktop/shared/workbench-location.mjs';
import {normalizeMetadataDocument,buildWorkbenchLocationPreview} from '../scripts/preview-workbench-location.mjs';

function fixture(t){
  const created=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-location-test-')),root=fs.realpathSync.native(created);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100}));
  const home=path.join(root,'home'),appData=path.join(root,'legacy-appdata'),profile=path.join(root,'existing-profile'),registry=path.join(home,'Documents','LingtuWorkbench','registry.json');
  fs.mkdirSync(path.join(profile,'workbench-server'),{recursive:true});fs.mkdirSync(path.dirname(registry),{recursive:true});
  const identity={schemaVersion:1,serverId:randomUUID(),dataSetId:randomUUID()};
  fs.writeFileSync(path.join(profile,'workbench-server','identity.json'),JSON.stringify(identity));fs.writeFileSync(registry,'{}');
  const marker={schemaVersion:1,profile,registryFile:registry,serverId:identity.serverId,dataSetId:identity.dataSetId};
  const write=value=>fs.writeFileSync(workbenchLocationFile(home),JSON.stringify(value));
  return {root,home,appData,profile,registry,identity,marker,write};
}
const invalid=fn=>assert.throws(fn,error=>error.code==='WORKBENCH_LOCATION_INVALID');

test('missing marker preserves legacy defaults without creating a profile',t=>{
  const f=fixture(t),result=getWorkbenchLocation(f.appData,{home:f.home});
  assert.deepEqual(result,{profile:path.join(f.appData,'wucheng-ecommerce-erp-v2'),registryFile:path.join(f.appData,'LingtuIntegrations','registry.json'),source:'legacy'});
  assert.equal(fs.existsSync(f.appData),false);assert.equal(fs.existsSync(workbenchLocationFile(f.home)),false);
});

test('Documents marker binds the same physical location across different AppData environments',t=>{
  const f=fixture(t);f.write(f.marker);
  for(const appData of[f.appData,path.join(f.root,'msix-appdata')]){
    const r=getWorkbenchLocation(appData,{home:f.home});assert.equal(r.profile,f.profile);assert.equal(r.registryFile,f.registry);assert.equal(r.source,'marker');assert.equal(r.serverId,f.identity.serverId);assert.equal(r.dataSetId,f.identity.dataSetId);
    assert.equal(defaultIntegrationRegistryPath(appData,{home:f.home}),f.registry);
  }
});

test('explicit profile is independent of an unrelated broken marker and creates nothing',t=>{
  const f=fixture(t);f.write({schemaVersion:99});const isolated=path.join(f.root,'isolated-new-profile'),registry=path.join(f.root,'isolated-registry.json');
  assert.deepEqual(getWorkbenchLocation(f.appData,{home:f.home,explicitProfile:isolated,registryFile:registry}),{profile:isolated,registryFile:registry,source:'explicit'});
  assert.equal(fs.existsSync(isolated),false);assert.equal(fs.existsSync(registry),false);
});

test('explicit registry wins while the selected default profile remains identity-checked',t=>{
  const f=fixture(t);f.write({...f.marker,registryFile:path.join(f.root,'absent-ignored-registry.json')});const r=getWorkbenchLocation(f.appData,{home:f.home,registryFile:f.registry});assert.equal(r.registryFile,f.registry);assert.equal(r.profile,f.profile);
  fs.unlinkSync(path.join(f.profile,'workbench-server','identity.json'));invalid(()=>getWorkbenchLocation(f.appData,{home:f.home,registryFile:f.registry}));
});

test('malformed, unsupported, relative and absent marker paths fail closed',t=>{
  const f=fixture(t),run=()=>getWorkbenchLocation(f.appData,{home:f.home});
  fs.writeFileSync(workbenchLocationFile(f.home),'{');invalid(run);
  for(const patch of[{schemaVersion:2},{profile:'relative-profile'},{registryFile:'relative-registry.json'},{profile:path.join(f.root,'absent-profile')},{registryFile:path.join(f.root,'absent-registry.json')},{profile:f.registry},{registryFile:f.profile}]){f.write({...f.marker,...patch});invalid(run);}
  assert.equal(fs.existsSync(path.join(f.root,'absent-profile')),false);
});

test('bound server identity cannot be missing, partial or replaced',t=>{
  const f=fixture(t),run=()=>getWorkbenchLocation(f.appData,{home:f.home});
  f.write({schemaVersion:1,profile:f.profile,registryFile:f.registry});invalid(run);
  f.write({...f.marker,dataSetId:undefined});invalid(run);
  f.write({...f.marker,serverId:'not-an-id'});invalid(run);
  f.write({...f.marker,dataSetId:randomUUID()});invalid(run);
  f.write(f.marker);fs.writeFileSync(path.join(f.profile,'workbench-server','identity.json'),JSON.stringify({...f.identity,serverId:randomUUID()}));invalid(run);
  fs.unlinkSync(path.join(f.profile,'workbench-server','identity.json'));invalid(run);
});

test('client markers verify remote pins rather than initializing host identity',t=>{
  const f=fixture(t);f.write(f.marker);fs.unlinkSync(path.join(f.profile,'workbench-server','identity.json'));
  const connection=path.join(f.profile,'workbench-connection.json');fs.writeFileSync(connection,JSON.stringify({mode:'client',pins:{serverId:f.identity.serverId,dataSetId:f.identity.dataSetId}}));
  assert.equal(getWorkbenchLocation(f.appData,{home:f.home}).serverId,f.identity.serverId);
  fs.writeFileSync(connection,JSON.stringify({mode:'client',pins:null}));invalid(()=>getWorkbenchLocation(f.appData,{home:f.home}));
  assert.equal(fs.existsSync(path.join(f.profile,'workbench-server','identity.json')),false);
});

test('unbound metadata marker accepts an existing ordinary client profile',t=>{
  const f=fixture(t);f.write({schemaVersion:1,profile:f.profile,registryFile:f.registry});fs.unlinkSync(path.join(f.profile,'workbench-server','identity.json'));
  const r=getWorkbenchLocation(f.appData,{home:f.home});assert.equal(r.source,'marker');assert.equal(r.serverId,undefined);
});

test('invalid registry JSON cannot fall back to another registry',t=>{
  const f=fixture(t);f.write(f.marker);for(const text of['bad','[]','null']){fs.writeFileSync(f.registry,text);invalid(()=>getWorkbenchLocation(f.appData,{home:f.home}));}
});

test('marker aliases must be normalized to their physical profile before adoption',t=>{
  const f=fixture(t),alias=path.join(f.root,'profile-alias');fs.symlinkSync(f.profile,alias,process.platform==='win32'?'junction':'dir');f.write({...f.marker,profile:alias});
  invalid(()=>getWorkbenchLocation(f.appData,{home:f.home}));
  const physical=fs.realpathSync.native(alias);f.write({...f.marker,profile:physical});assert.equal(getWorkbenchLocation(f.appData,{home:f.home}).profile,f.profile);
});

test('metadata normalizer changes only allowed existing physical paths',t=>{
  const f=fixture(t),nested=path.join(f.profile,'nested');fs.mkdirSync(nested);const file=path.join(nested,'node.exe');fs.writeFileSync(file,'fixture');
  const value={root:f.profile,dataDir:f.profile,exe:file,nodePath:file,browserPath:file,entry:'unchanged-relative-entry',unknownPath:'do-not-touch',nested:{root:missingPath(f)}};
  const before=JSON.stringify(value),r=normalizeMetadataDocument(value);assert.equal(JSON.stringify(value),before);assert.equal(r.document.entry,value.entry);assert.equal(r.document.unknownPath,value.unknownPath);assert.equal(r.blocked.length,1);assert.equal(r.blocked[0].pointer,'/nested/root');
});
const missingPath=f=>path.join(f.root,'does-not-exist');

test('preview provides path review and metadata backup plan without touching source or business files',t=>{
  const f=fixture(t),modules=path.join(f.profile,'modules');fs.mkdirSync(modules);const program=path.join(f.root,'program'),data=path.join(f.root,'data');fs.mkdirSync(program);fs.mkdirSync(data);fs.writeFileSync(path.join(data,'orders.sqlite'),'do not open, copy or move');
  const registry={purchase:{managed:true,root:program,dataDir:data,allowInitialize:false}},installed={schemaVersion:1,packages:{purchase:{root:program,entry:'server.mjs',version:'test'}}};
  fs.writeFileSync(f.registry,JSON.stringify(registry));const file=path.join(modules,'installed.json');fs.writeFileSync(file,JSON.stringify(installed));
  const files=[f.registry,file,path.join(data,'orders.sqlite')],digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=files.map(digest);const result=buildWorkbenchLocationPreview({profile:f.profile,registryFile:f.registry,home:f.home,now:new Date('2026-10-25T00:00:00Z')});
  assert.equal(result.previewOnly,true);assert.equal(result.readyForReview,true);assert.equal(result.proposedMarker.content.profile,f.profile);assert.equal(result.proposedMarker.content.serverId,f.identity.serverId);assert.equal(result.backupPlan.businessFilesCopiedOrMoved,false);assert(!result.backupPlan.files.some(x=>x.source.endsWith('.sqlite')));assert.deepEqual(files.map(digest),before);assert.equal(fs.existsSync(result.backupPlan.directory),false);assert.equal(fs.existsSync(workbenchLocationFile(f.home)),false);
});

test('preview blocks initialization permission and missing paths instead of synthesizing replacements',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.profile,'modules'));fs.writeFileSync(path.join(f.profile,'modules','installed.json'),JSON.stringify({packages:{purchase:{root:f.profile}}}));fs.writeFileSync(f.registry,JSON.stringify({purchase:{managed:true,root:f.profile,dataDir:missingPath(f),allowInitialize:true}}));
  const r=buildWorkbenchLocationPreview({profile:f.profile,registryFile:f.registry,home:f.home});assert.equal(r.readyForReview,false);assert(r.blocked.some(x=>x.pointer==='/purchase/dataDir'));assert(r.blocked.some(x=>x.pointer==='/purchase/allowInitialize'));assert.equal(fs.existsSync(missingPath(f)),false);
});
