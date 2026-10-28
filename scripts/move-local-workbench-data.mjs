import fs from 'node:fs';import path from 'node:path';
import crypto from 'node:crypto';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {getWorkbenchLocation} from '../desktop/shared/workbench-location.mjs';
import {previewLocalDataMove,stageLocalDataMove,verifyLocalDataMove,completeLocalDataMove,rollbackLocalDataMove} from '../desktop/workbench-migration/local-data-move.mjs';
const [mode,destination,backupRoot]=process.argv.slice(2);
if(['verify','complete','rollback'].includes(mode)){
 const result=mode==='verify'?verifyLocalDataMove(destination,{afterActivation:process.argv.includes('--after-activation')}):mode==='complete'?completeLocalDataMove(destination):rollbackLocalDataMove(destination);console.log(JSON.stringify(result));
}else{
 if(!['preview','apply'].includes(mode)||!path.isAbsolute(destination||'')||!path.isAbsolute(backupRoot||''))throw Error('preview|apply ABSOLUTE_DATA_ROOT ABSOLUTE_PRIVATE_BACKUP_ROOT; verify|complete|rollback JOURNAL');
 const location=getWorkbenchLocation(),services=new ServiceManager({registryFile:location.registryFile,policyFile:path.join(location.profile,'workbench-server/access-policy.json')});
 const plan=await previewLocalDataMove({services,dataRoot:destination,backupRoot});
 if(mode==='preview')console.log(JSON.stringify({ok:true,bytes:plan.bytes,modules:plan.modules.map(m=>({id:m.id,files:m.files.length,bytes:m.bytes,running:m.wasRunning})),mutation:false}));
 else{
  fs.mkdirSync(backupRoot,{recursive:true});const result=await stageLocalDataMove({services,plan,onProgress:p=>console.log(JSON.stringify(p))});
  // stage has stopped both native workers. Back up their compatible authentication
  // roots before the new suite can reuse them; never include this in a release.
  const auth=path.join(path.dirname(result.journalFile),'authentication'),manifest=[];
  const entries=['Partitions','Network','Local State','Local Storage','Session Storage','IndexedDB','Preferences','Secure Preferences'];
  const copy=(source,target,label)=>{if(!fs.existsSync(source))return;const stat=fs.lstatSync(source);if(stat.isSymbolicLink())throw Error('认证备份含链接，请保留维护状态核对');if(stat.isDirectory()){fs.mkdirSync(target,{recursive:true});for(const name of fs.readdirSync(source))if(!/^(?:Singleton.*|lockfile|LOCK)$/.test(name))copy(path.join(source,name),path.join(target,name),label+'/'+name);}else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);const h=x=>crypto.createHash('sha256').update(fs.readFileSync(x)).digest('hex');const digest=h(source);if(h(target)!==digest)throw Error('认证备份摘要不符');manifest.push({relative:label,bytes:stat.size,sha256:digest});}};
  for(const id of ['warehouse','exporter'])for(const name of entries){const root=plan.modules.find(m=>m.id===id).source;copy(path.join(root,name),path.join(auth,id,name),id+'/'+name);}
  for(const name of ['launcher','workbench-server','workbench-connection.json'])copy(path.join(location.profile,name),path.join(auth,'workbench',name),'workbench/'+name);
  fs.writeFileSync(path.join(path.dirname(result.journalFile),'authentication-manifest.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({...result,authenticationFiles:manifest.length}));
 }
}
