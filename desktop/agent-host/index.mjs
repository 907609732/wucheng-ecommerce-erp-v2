import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createHostIdentity} from './identity.mjs';
import {createSafeSecretStore} from './secret-store.mjs';
import {createAgentModuleTransport} from './module-transport.mjs';
import {startAgentBridge} from './bridge.mjs';
import {artifactDownload} from './artifacts.mjs';
import {composeAgentDependencies} from './composition.mjs';
import {hostError} from './common.mjs';
import {createCompanyIdentity} from './company-identity.mjs';
import {createLegacyScheduleTakeover} from './schedules.mjs';

export async function createAgentHost({paths,services,safeStorage,principal,identity:providedIdentity,loadDependencies=composeAgentDependencies,runtimeFactory,adapters,engines,createBackups,engineResourceDir,connectionHandlers={},onError=()=>{},startBridge=true}={}){
  const hostDir=path.join(paths.profile,'agent-host'),storeDir=path.join(paths.profile,'agent-runtime');
  const identity=providedIdentity||createHostIdentity({storeDir:hostDir,policyFile:path.join(paths.profile,'workbench-server','access-policy.json'),...(principal?{principal}:{})});
  const getCompanyIdentity=createCompanyIdentity({profile:paths.profile,storeDir}),resolveActor=id=>{getCompanyIdentity();return identity.resolveActor(id);};
  const secretStore=createSafeSecretStore({storeDir:hostDir,safeStorage});let runtime;
  function approved(claims,id){
    if(!runtime||claims.module!==id)return false;
    const task=runtime.store.get('task',claims.taskId),result=runtime.store.get('result',claims.resultId);
    if(!task||task.status!=='committing'||task.approvedBy!==claims.actorId||task.resultId!==claims.resultId||task.review?.id!==claims.approvalId||task.review.resultVersion!==claims.resultVersion||result?.version!==claims.resultVersion)return false;
    return result.prepared.some(step=>step.module===id&&step.capabilityId===claims.capabilityId&&step.changeDigest===claims.changeDigest&&step.binding.dataSetId===claims.dataSetId&&JSON.stringify(step.binding.revision)===JSON.stringify(claims.revision));
  }
  const transport=createAgentModuleTransport({services,resolveActor,validateApproval:approved,artifactRoot:path.join(storeDir,'tasks')});
  const dependencies=runtimeFactory?{runtimeFactory,adapters:adapters||[],engines:engines||{},createBackups}:await loadDependencies({transport,engineResourceDir});
  const adapterMap=new Map(dependencies.adapters.map(adapter=>[adapter.id,adapter]));
  const backupHooks=dependencies.createBackups?.({paths:{...paths,registry:paths.registryFile},services,storeDir,resolveActor,getCompanyIdentity,binding:async(id,ctx)=>{const adapter=adapterMap.get(id);if(!adapter)throw hostError('MODULE_UNAVAILABLE','此模块尚未接入备份绑定',503);return adapter.binding(ctx);}})||{};
  const systemKeyFile=path.join(hostDir,'.agent-approval-key');
  try{fs.writeFileSync(systemKeyFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const signApproval=async(claims,id)=>{
    if(id!=='system')return transport.signApproval(claims,id);
    if(!approved(claims,id))throw hostError('AGENT_APPROVAL_REQUIRED','没有可核对的已审批系统任务',403);
    const actor=resolveActor(claims.actorId);if(!actor||actor.role==='viewer'||!actor.canRunTasks)throw hostError('TASK_PERMISSION_REQUIRED','系统任务权限已撤销',403);
    const {signAgentApproval}=await import('../agent-runtime/approval.mjs');return signAgentApproval(claims,fs.readFileSync(systemKeyFile,'utf8'));
  };
  runtime=dependencies.runtimeFactory({storeDir,adapters:dependencies.adapters,engines:dependencies.engines,resolveActor,secretStore,signApproval,environment:{...paths.environment,tenantLabel:'测试租户'},extensions:{
    'permissions.get':identity.permissionsGet,'permissions.inspect':identity.permissionsInspect,'permissions.receipt':identity.permissionsReceipt,'permissions.save':identity.permissionsSave,
    'artifacts.open':item=>artifactDownload(storeDir,item),...backupHooks,...connectionHandlers
  }});
  const takeover=createLegacyScheduleTakeover({warehouse:adapterMap.get('warehouse'),runtime,identity,getCompanyIdentity,onError});
  const dispatch=runtime.request;
  runtime.request=async(operation,payload,meta)=>{getCompanyIdentity();if(['permissions.inspect','permissions.receipt'].includes(operation)||operation.startsWith('backups.'))throw hostError('INTERNAL_OPERATION','此接口仅用于准备已授权系统任务',403);const result=await dispatch(operation,payload,meta);return operation==='status'?{...result,legacyScheduleMigration:takeover.status()}:result;};
  let tickJob=null,closing=false;
  const timer=setInterval(()=>{if(tickJob||closing)return;tickJob=Promise.resolve().then(()=>takeover.run()).then(()=>runtime.tick()).catch(onError).finally(()=>{tickJob=null;});},15000);timer.unref();
  let bridge;try{bridge=startBridge?await startAgentBridge({storeDir:hostDir,request:runtime.request}):null;}catch(error){clearInterval(timer);await runtime.close();throw error;}
  void takeover.run();
  return {runtime,identity,transport,secretStore,storeDir,request:runtime.request,async close(){if(closing)return;closing=true;clearInterval(timer);await takeover.close();await tickJob;await bridge?.close();await runtime.close();}};
}
