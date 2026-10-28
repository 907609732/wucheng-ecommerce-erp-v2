// Preview only: no apply mode, directory creation, service start, or database open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {canonicalUserDataPath} from '../desktop/shared/user-data-path.mjs';
import {workbenchLocationFile,resolvePhysicalDirectory} from '../desktop/shared/workbench-location.mjs';

const fields=new Set(['root','dataDir','exe','nodePath','browserPath']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

export function normalizeMetadataDocument(document){
  const result=structuredClone(document),changes=[],blocked=[];
  function visit(value,pointer=''){
    if(!value||typeof value!=='object')return;
    for(const [name,item]of Object.entries(value)){
      const at=pointer+'/'+name.replaceAll('~','~0').replaceAll('/','~1');
      if(fields.has(name)&&typeof item==='string'&&item){
        if(!path.isAbsolute(item)){blocked.push({pointer:at,reason:'Path is not absolute'});continue;}
        try{
          const physical=name==='dataDir'?resolvePhysicalDirectory(item,['workspace/data/erp.sqlite','orders.sqlite','purchases.sqlite','sales.sqlite','overview.sqlite']):fs.realpathSync.native(item),stat=fs.statSync(physical);
          if(['root','dataDir'].includes(name)?!stat.isDirectory():!stat.isFile())throw Error('Unexpected path type');
          value[name]=physical;
          if(item!==physical)changes.push({pointer:at,before:item,after:physical});
        }catch{blocked.push({pointer:at,reason:'Existing physical target is missing or has an unexpected type'});}
      }else if(item&&typeof item==='object')visit(item,at);
    }
  }
  visit(result);
  return {document:result,changes,blocked};
}

export function buildWorkbenchLocationPreview({profile=canonicalUserDataPath(process.env.APPDATA||os.homedir()),registryFile=path.join(process.env.APPDATA||os.homedir(),'LingtuIntegrations','registry.json'),home=os.homedir(),now=new Date()}={}){
  const physicalProfile=resolvePhysicalDirectory(profile,['workbench-server/identity.json','workbench-connection.json','modules/installed.json']),physicalRegistry=fs.realpathSync.native(registryFile);
  if(!fs.statSync(physicalProfile).isDirectory()||!fs.statSync(physicalRegistry).isFile())throw Error('Existing source metadata paths are required');
  const markerFile=workbenchLocationFile(home),registryDestination=path.join(path.dirname(markerFile),'registry.json');
  const installedFile=path.join(physicalProfile,'modules','installed.json');
  if(!fs.existsSync(installedFile))throw Error('Existing installed.json is required; preview will not create one');
  const identityFile=path.join(physicalProfile,'workbench-server','identity.json');
  if(!fs.existsSync(identityFile))throw Error('Existing host identity is required; preview will not initialize a server');
  const identity=read(identityFile);
  if(identity.schemaVersion!==1||!identity.serverId||!identity.dataSetId)throw Error('Existing host identity is incomplete');
  const sourceRegistry=read(physicalRegistry),sourceInstalled=read(installedFile);
  if(!sourceRegistry||typeof sourceRegistry!=='object'||Array.isArray(sourceRegistry)||!sourceInstalled?.packages||typeof sourceInstalled.packages!=='object')throw Error('Existing metadata format is invalid');
  const registry=normalizeMetadataDocument(sourceRegistry),installed=normalizeMetadataDocument(sourceInstalled);
  const blocked=[...registry.blocked.map(x=>({file:'registry.json',...x})),...installed.blocked.map(x=>({file:'installed.json',...x}))];
  for(const [id,config]of Object.entries(registry.document)){
    if(config?.allowInitialize===true)blocked.push({file:'registry.json',pointer:'/'+id+'/allowInitialize',reason:'Existing authoritative host must not allow empty-ledger initialization'});
    const pkg=installed.document.packages[id];
    if(config?.managed&&pkg&&config.root!==pkg.root)blocked.push({file:'registry.json',pointer:'/'+id+'/root',reason:'Registry and installed package root disagree'});
  }
  const marker={schemaVersion:1,profile:physicalProfile,registryFile:registryDestination,serverId:identity.serverId,dataSetId:identity.dataSetId};
  const stamp=now.toISOString().replaceAll(':','-'),backupRoot=path.join(path.dirname(markerFile),'location-backups',stamp);
  const backupSources=[physicalRegistry,installedFile,identityFile,path.join(physicalProfile,'workbench-connection.json'),...(fs.existsSync(markerFile)?[markerFile]:[]),...(fs.existsSync(registryDestination)&&path.resolve(registryDestination)!==path.resolve(physicalRegistry)?[registryDestination]:[])].filter(f=>fs.existsSync(f));
  return {schemaVersion:1,previewOnly:true,readyForReview:blocked.length===0,generatedAt:now.toISOString(),source:{logicalProfile:profile,physicalProfile,logicalRegistry:registryFile,physicalRegistry},proposedMarker:{file:markerFile,content:marker},files:[{kind:'registry',source:physicalRegistry,destination:registryDestination,sourceSha256:hash(fs.readFileSync(physicalRegistry)),changes:registry.changes},{kind:'installed',source:installedFile,destination:installedFile,sourceSha256:hash(fs.readFileSync(installedFile)),changes:installed.changes}],blocked,backupPlan:{directory:backupRoot,files:backupSources.map((file,index)=>({source:file,destination:path.join(backupRoot,String(index)+'-'+path.basename(file)),sha256:hash(fs.readFileSync(file))})),businessFilesCopiedOrMoved:false},executionRequirements:['Require all five modules idle and no import, collection, migration, or save in progress.','Back up listed metadata and recheck source hashes, persisted server/dataSet identity, and original ledger UUIDs before any approved write.','Use controlled shutdown with the old metadata before changing path strings; do not reuse live capability paths from the old namespace.','Write normalized registry to Documents and normalize only allowlisted installed.json path fields in its existing profile; retain every other value.','Write Documents location marker last, using atomic replace, after registry/profile read-back and identity verification.','Pass explicit resolved profile and registry to launcher, gateway, modules, CLI and MCP; missing bound paths must fail closed.','Validate an ordinary Explorer launch outside the Codex MSIX package context and recheck original ledger UUIDs, baseline files, HTTPS443/8443, and client connection.'],excluded:['Business databases and WAL files','Orders, attachments, originals, login partitions, and credentials','Historical .failed directories and module-backups','Real Tailscale configuration and member permissions']};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const options={};
    for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--profile','--registry','--home'].includes(key)||!value)throw Error('Preview accepts only --profile PATH --registry PATH --home PATH; no apply mode');options[{'--profile':'profile','--registry':'registryFile','--home':'home'}[key]]=path.resolve(value);}
    const result=buildWorkbenchLocationPreview(options);process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.readyForReview)process.exitCode=2;
  }catch(error){process.stderr.write('Location preview failed: '+error.message+'\n');process.exitCode=1;}
}
