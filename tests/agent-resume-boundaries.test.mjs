import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createHostIdentity} from '../desktop/agent-host/identity.mjs';
import {createGatewayStore} from '../desktop/workbench/store.mjs';
import {artifactPreview} from '../desktop/agent-host/artifacts.mjs';
import {prepareResultCorrections} from '../desktop/agent-runtime/result-corrections.mjs';

function directory(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'erp-resume-boundaries-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('assignable directory uses real observed logins without configurable business restrictions',t=>{
  const root=directory(t),principal={id:'windows:owner',login:'windows:owner',label:'Local Owner'},profile=path.join(root,'profile'),identity=createHostIdentity({storeDir:path.join(profile,'agent-host'),principal}),gateway=createGatewayStore(path.join(profile,'workbench-server'));
  try{gateway.observeMember('employee@example.test');gateway.observeMember('other@example.test');}finally{gateway.close();}
  const actor=identity.resolveActor('tailscale:employee@example.test'),rows=identity.listAssignableActors({modules:['purchase']},{actor}).people;
  assert.deepEqual(rows.map(row=>row.id).sort(),['tailscale:employee@example.test','tailscale:other@example.test','windows:owner']);
  assert(rows.every(row=>Object.keys(row).sort().join(',')==='id,label,modules'));
  assert.equal(identity.listAssignableActors({modules:['sales']},{actor}).people.length,3);
  assert.equal(identity.resolveActor('tailscale:model-invented@example.test'),null);
  assert.throws(()=>identity.listAssignableActors({modules:['purchase']},{actor:{id:'tailscale:model-invented@example.test',role:'admin'}}),{code:'IDENTITY_REQUIRED'});
});

test('preview verifies scope, hash and media bytes rather than trusting a MIME label',t=>{
  const root=directory(t),taskId='task-preview',dir=path.join(root,'tasks',taskId);fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'proof.png'),bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0]);fs.writeFileSync(file,bytes);
  const item={taskId,path:file,name:'proof.png',mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')};
  assert.equal(artifactPreview(root,item).preview.bytes,bytes.toString('base64'));
  assert.throws(()=>artifactPreview(root,{...item,mimeType:'application/pdf'}),{code:'ARTIFACT_PREVIEW_UNSUPPORTED'});
  assert.throws(()=>artifactPreview(root,{...item,taskId:'other-task'}));
  fs.writeFileSync(file,'changed');assert.throws(()=>artifactPreview(root,item),{code:'ARTIFACT_CHANGED'});
});

function correctionFixture(){
  const actor={id:'person',role:'editor',modules:['purchase'],canRunTasks:true},task={id:'task',resultId:'result',status:'waiting_review'},result={id:'result',version:3,blocks:[{id:'draft-order',type:'table',sourceModule:'purchase',sourceCapabilityId:'order.create',rowKey:'draftId',editableFields:['amountCents'],rows:[{draftId:'stable-row',amountCents:100}]}],prepared:[{module:'purchase',capabilityId:'order.create'}]},adapterMap=new Map([['purchase',{capabilities:[{id:'order.create',resultEditFields:['amountCents']}]}]]),payload={corrections:{resultId:'result',resultVersion:3,edits:[{blockId:'draft-order',rowKey:'stable-row',field:'amountCents',before:100,after:200}]}};
  return {actor,task,result,adapterMap,payload,now:()=>100};
}

test('human corrections preserve the original prepared result and require fresh version and old values',()=>{
  const f=correctionFixture(),before=structuredClone(f.result),output=prepareResultCorrections(f);
  assert.deepEqual(f.result,before);assert.equal(output.corrections.actorId,'person');assert.equal(output.corrections.edits[0].module,'purchase');
  assert.equal(output.corrections.edits[0].after,200);
  f.payload.corrections.resultVersion=2;assert.throws(()=>prepareResultCorrections(f),{code:'RESULT_STALE'});
  f.payload.corrections.resultVersion=3;f.payload.corrections.edits[0].before=99;assert.throws(()=>prepareResultCorrections(f),{code:'RESULT_ROW_CHANGED'});
});

test('generic corrections require a logged-in member and a fresh editable draft, without obsolete role gates',()=>{
  let f=correctionFixture();f.payload.corrections.edits[0].field='draftId';assert.throws(()=>prepareResultCorrections(f),{code:'RESULT_FIELD_READ_ONLY'});
  f=correctionFixture();f.result.blocks[0].rows.push({draftId:'stable-row',amountCents:100});assert.throws(()=>prepareResultCorrections(f),{code:'RESULT_ROW_CHANGED'});
  f=correctionFixture();f.result.receipt={state:'verified'};assert.throws(()=>prepareResultCorrections(f),{code:'RESULT_NOT_EDITABLE'});
  f=correctionFixture();f.actor={...f.actor,role:'viewer',canRunTasks:false,modules:[]};assert.equal(prepareResultCorrections(f).corrections.actorId,'person');
  f=correctionFixture();f.actor.enabled=false;assert.throws(()=>prepareResultCorrections(f),{code:'IDENTITY_REQUIRED'});
  f=correctionFixture();f.actor={};assert.throws(()=>prepareResultCorrections(f),{code:'IDENTITY_REQUIRED'});
  f=correctionFixture();f.payload.corrections.edits.push({...f.payload.corrections.edits[0]});assert.throws(()=>prepareResultCorrections(f),{code:'CORRECTIONS_DUPLICATE'});
});
