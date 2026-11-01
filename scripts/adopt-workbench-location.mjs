// Host-only, explicitly reviewed metadata adoption. Never moves or restores a ledger.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {validatePolicy} from '../desktop/workbench/policy.mjs';
import {getWorkbenchLocation,resolvePhysicalDirectory,workbenchLocationFile} from '../desktop/shared/workbench-location.mjs';
import {buildWorkbenchLocationPreview,normalizeMetadataDocument} from './preview-workbench-location.mjs';

const ids=['warehouse','purchase','sales','overview','exporter'];
const stopOrder=['overview','sales','purchase','exporter','warehouse'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const fail=code=>Object.assign(Error(code),{code});
const equalPath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const digestFile=file=>hash(fs.readFileSync(file));
const physicalFile=file=>fs.realpathSync.native(file);

export function validateReviewedPreview(reviewed,{home=os.homedir()}={}){
  if(reviewed?.schemaVersion!==1||reviewed.previewOnly!==true||reviewed.readyForReview!==true||!reviewed.generatedAt||!reviewed.source)throw fail('INVALID_REVIEW');
  if(!uuid.test(reviewed.proposedMarker?.content?.serverId||'')||!uuid.test(reviewed.proposedMarker?.content?.dataSetId||''))throw fail('INVALID_REVIEW_IDENTITY');
  if(!equalPath(reviewed.proposedMarker?.file||'',workbenchLocationFile(home)))throw fail('MARKER_DESTINATION_CHANGED');
  if(fs.existsSync(reviewed.proposedMarker.file))throw fail('LOCATION_ALREADY_MARKED');
  const fresh=buildWorkbenchLocationPreview({profile:reviewed.source.logicalProfile,registryFile:reviewed.source.logicalRegistry,home,now:new Date(reviewed.generatedAt)});
  if(!isDeepStrictEqual(fresh,reviewed))throw fail('REVIEW_CHANGED');
  return fresh;
}

export function captureLedgerBinding(id,config){
  const file=path.join(config.dataDir,config.db||(id==='exporter'?'orders.sqlite':''));
  if(!config.managed||config.allowInitialize!==false||!config.db&&id!=='exporter'||!fs.existsSync(file))throw fail('ORIGINAL_LEDGER_REQUIRED');
  const physical=physicalFile(file),stat=fs.statSync(physical,{bigint:true});
  if(!stat.isFile()||stat.size===0n)throw fail('ORIGINAL_LEDGER_REQUIRED');
  const db=new DatabaseSync(physical,{readOnly:true});
  try{
    const key=['warehouse','exporter'].includes(id)?'ledger-instance':'ledger:'+id;
    const dataSetId=db.prepare('SELECT value FROM workbench_identity WHERE key=?').get(key)?.value;
    if(!uuid.test(dataSetId||''))throw fail('LEDGER_IDENTITY_MISSING');
    return {id,file:physical,device:stat.dev.toString(),fileId:stat.ino.toString(),dataSetId};
  }finally{db.close();}
}

export function assertNoPendingWrites(profile){
  const gateway=path.join(profile,'workbench-server','gateway.sqlite');
  if(!fs.existsSync(gateway))throw fail('GATEWAY_STORE_REQUIRED');
  const db=new DatabaseSync(gateway,{readOnly:true});
  try{if(db.prepare("SELECT COUNT(*) AS n FROM operations WHERE state IN ('pending','unknown')").get().n!==0)throw fail('GATEWAY_WRITES_PENDING');}
  finally{db.close();}
  const root=path.join(profile,'workbench-server','migrations');
  if(!fs.existsSync(root))return;
  if(fs.existsSync(path.join(root,'maintenance-window.lock')))throw fail('MIGRATION_WINDOW_PRESENT');
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(!uuid.test(entry.name))continue;
    if(entry.isSymbolicLink()||!entry.isDirectory())throw fail('MIGRATION_STATE_INVALID');
    const file=path.join(root,entry.name,'batch.json');
    if(fs.existsSync(file)&&['committing','verified','releasing','recovery-required'].includes(read(file).status))throw fail('MIGRATION_NOT_SETTLED');
    if(fs.existsSync(file+'.lock'))throw fail('MIGRATION_LOCK_PRESENT');
  }
}

function assertInstallIdle(profile,{ownedLock}={}){
  if(fs.existsSync(path.join(profile,'modules','transaction.json')))throw fail('INSTALL_JOURNAL_PRESENT');
  const lock=path.join(profile,'modules','install.lock');
  if(fs.existsSync(lock)&&(!ownedLock||read(lock).adoptionToken!==ownedLock))throw fail('INSTALL_LOCK_PRESENT');
}

export async function assertNoLiveStartRecord(file,module,system){
  if(!fs.existsSync(file))return;
  let record,source;
  try{
    source=fs.readFileSync(file,'utf8');const raw=source.trim();
    if(/^\d+$/.test(raw))record={ownerPid:Number(raw),childPid:null};
    else{
      record=JSON.parse(raw);
      if(record.schemaVersion!==1||typeof record.token!=='string'||record.module!==module||record.childPid!==null&&(!Number.isSafeInteger(record.childPid)||record.childPid<=0))throw Error();
    }
    if(!Number.isSafeInteger(record.ownerPid)||record.ownerPid<=0)throw Error();
  }catch{throw fail('MODULE_START_RECORD_INVALID');}
  if(await system.processInfo(record.childPid??record.ownerPid))throw fail('MODULE_START_RECORD_ALIVE');
  // The legacy owner may have spawned a child and exited before that child
  // listened. A dead owner (or unpublished child PID) proves nothing about it.
  if(record.childPid===null)throw fail('MODULE_START_RECORD_UNCERTAIN');
  if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==source)throw fail('MODULE_START_RECORD_CHANGED');
  // A dead record is retained intentionally by ServiceManager for its next
  // controlled reclamation. Adoption must neither delete it nor spawn a child.
}

function atomic(file,bytes){
  const temporary=file+'.adoption-'+randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

// Windows' official CommandLineToArgvW parses argv; no string-built shell paths.
function powershell(script,env={}){
  const exe=path.join(process.env.SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const quiet="$ProgressPreference='SilentlyContinue';$InformationPreference='SilentlyContinue';\n"+script;
  return JSON.parse(execFileSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(quiet,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,...env},maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).trim()||'null');
}
const processQuery=`$ErrorActionPreference='Stop'
$wanted=[int]$env:LINGTU_ADOPT_PID
$listenerAddresses=@()
if($wanted -eq 0){$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 17330);if($listeners.Count -eq 0){'null';exit};if($listeners.Count -ne 1){throw 'Unexpected gateway listener'};$wanted=$listeners[0].OwningProcess;$listenerAddresses=@($listeners.LocalAddress)}
$item=Get-CimInstance Win32_Process -Filter ('ProcessId='+$wanted)
if(!$item){'null';exit}
$proc=Get-Process -Id $wanted -ErrorAction SilentlyContinue;if(!$proc){'null';exit}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class WorkbenchArgv { [DllImport("shell32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern IntPtr CommandLineToArgvW(string line,out int count);[DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory); }'
$count=0;$memory=[WorkbenchArgv]::CommandLineToArgvW($item.CommandLine,[ref]$count);if($memory -eq [IntPtr]::Zero){throw 'Cannot inspect argv'}
try{$parsedArgs=@(for($i=0;$i -lt $count;$i++){[Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory,$i*[IntPtr]::Size))})}finally{[WorkbenchArgv]::LocalFree($memory)|Out-Null}
@{pid=$wanted;startedAtTicks=$proc.StartTime.ToUniversalTime().Ticks.ToString();exe=$proc.MainModule.FileName;args=$parsedArgs;listenerAddresses=$listenerAddresses}|ConvertTo-Json -Depth 5 -Compress`;

export function createWindowsAdoptionSystem(){
  if(process.platform!=='win32')throw fail('WINDOWS_HOST_REQUIRED');
  const processInfo=async pid=>powershell(processQuery,{LINGTU_ADOPT_PID:String(pid)});
  return {
    inspectGateway:()=>processInfo(0),processInfo,
    assertNoHostLaunchers:async()=>{
      const logical=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Programs','wucheng-ecommerce-erp-v2','云仓库存同步.exe');
      const paths=[logical,...(fs.existsSync(logical)?[physicalFile(logical)]:[])];
      const found=powershell(`$ErrorActionPreference='Stop';$paths=@($env:LINGTU_ADOPT_LAUNCHERS|ConvertFrom-Json);$found=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $paths -contains $_.ExecutablePath });@{count=$found.Count}|ConvertTo-Json -Compress`,{LINGTU_ADOPT_LAUNCHERS:JSON.stringify(paths)});
      if(found.count!==0)throw fail('HOST_LAUNCHER_ACTIVE');
    },
    findManagedModuleProcesses:async scopes=>{
      const found=powershell(`$ErrorActionPreference='Stop';$s=$env:LINGTU_ADOPT_SCOPES|ConvertFrom-Json;$found=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $p=$_;$match=$s.electronExes -contains $p.ExecutablePath;if(!$match -and $s.nodePaths -contains $p.ExecutablePath){foreach($entry in $s.entryPaths){if($p.CommandLine -and $p.CommandLine.IndexOf($entry,[StringComparison]::OrdinalIgnoreCase) -ge 0){$match=$true;break}}};$match });@{count=$found.Count}|ConvertTo-Json -Compress`,{LINGTU_ADOPT_SCOPES:JSON.stringify(scopes)});
      return found.count;
    },
    health:async()=>{const r=await fetch('http://127.0.0.1:17330/api/workbench/v1/health',{redirect:'error',signal:AbortSignal.timeout(3000)});if(!r.ok)throw fail('GATEWAY_NOT_HEALTHY');return r.json();},
    waitForExit:async original=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const current=await processInfo(original.pid);if(!current||current.startedAtTicks!==original.startedAtTicks)return;await new Promise(r=>setTimeout(r,250));}throw fail('OWNED_PROCESS_DID_NOT_EXIT');},
    stopGateway:async original=>{
      // Process.Kill operates on this exact process handle after a birth-time
      // check. It cannot target a later process that reused the PID.
      powershell(`$ErrorActionPreference='Stop';$expected=$env:LINGTU_ADOPT_PROCESS|ConvertFrom-Json;$p=Get-Process -Id ([int]$expected.pid) -ErrorAction Stop;$null=$p.Handle;if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $expected.startedAtTicks -or $p.MainModule.FileName -ne $expected.exe){throw 'Gateway process changed'};$p.Kill();@{ok=$true}|ConvertTo-Json -Compress`,{LINGTU_ADOPT_PROCESS:JSON.stringify(original)});
    }
  };
}

export function validateGatewayOwner(snapshot,preview,installed,connection){
  if(!Number.isSafeInteger(snapshot?.pid)||snapshot.pid<=0||!snapshot.startedAtTicks||!Array.isArray(snapshot.args)||snapshot.args.length<2)throw fail('GATEWAY_OWNER_INVALID');
  if(!isDeepStrictEqual(snapshot.listenerAddresses,['127.0.0.1']))throw fail('GATEWAY_LISTENER_MISMATCH');
  const runtime=installed.packages?.['node-runtime'];
  if(!runtime||typeof runtime.entry!=='string'||path.isAbsolute(runtime.entry)||runtime.entry.split(/[\\/]/).includes('..'))throw fail('MANAGED_NODE_REQUIRED');
  const expectedNode=physicalFile(path.join(runtime.root,runtime.entry));
  if(!equalPath(physicalFile(snapshot.exe),expectedNode)||!equalPath(physicalFile(snapshot.args[0]),expectedNode))throw fail('GATEWAY_NODE_MISMATCH');
  const entry=physicalFile(snapshot.args[1]),relative=path.relative(preview.source.physicalProfile,entry).split(path.sep);
  if(relative.length!==5||relative[0]!=='gateway-components'||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(relative[1])||relative.slice(2).join('/')!=='desktop/workbench-migration/server-entry.mjs')throw fail('GATEWAY_ENTRY_MISMATCH');
  const args={};for(let i=2;i<snapshot.args.length;i+=2){const key=snapshot.args[i],value=snapshot.args[i+1];if(!['--store-dir','--origin','--port'].includes(key)||!value||args[key])throw fail('GATEWAY_ARGUMENTS_INVALID');args[key]=value;}
  const store=resolvePhysicalDirectory(args['--store-dir']||'', ['identity.json']);
  if(!equalPath(store,path.join(preview.source.physicalProfile,'workbench-server'))||args['--origin']!==connection.serverUrl||args['--port']&&args['--port']!=='17330')throw fail('GATEWAY_STORE_MISMATCH');
  return {...snapshot,physicalEntry:entry};
}

function verifyUnchanged(preview,policyFile,policyHash,ownedLock){
  assertInstallIdle(preview.source.physicalProfile,{ownedLock});
  for(const item of preview.backupPlan.files)if(!fs.existsSync(item.source)||digestFile(item.source)!==item.sha256)throw fail('SOURCE_METADATA_CHANGED');
  if(digestFile(policyFile)!==policyHash)throw fail('ACCESS_POLICY_CHANGED');
}

function verifyAfterOwnWrites(preview,policyFile,policyHash,ownedLock,writes){
  assertInstallIdle(preview.source.physicalProfile,{ownedLock});
  for(const item of preview.backupPlan.files){const own=writes.find(w=>equalPath(w.file,item.source));if(!fs.existsSync(item.source)||digestFile(item.source)!==(own?.newHash||item.sha256))throw fail('SOURCE_METADATA_CHANGED');}
  for(const item of writes)if(!fs.existsSync(item.file)||digestFile(item.file)!==item.newHash)throw fail('METADATA_TARGET_CHANGED');
  if(digestFile(policyFile)!==policyHash)throw fail('ACCESS_POLICY_CHANGED');
}

export async function adoptWorkbenchLocation(reviewFile,{home=os.homedir(),system,servicesFactory=options=>new ServiceManager(options),checkpoint=()=>{}}={}){
  const preview=validateReviewedPreview(read(reviewFile),{home}),profile=preview.source.physicalProfile;
  const policyFile=path.join(profile,'workbench-server','access-policy.json');validatePolicy(read(policyFile));const policyHash=digestFile(policyFile);
  const connection=read(path.join(profile,'workbench-connection.json'));
  if(connection.mode!=='server')throw fail('EXISTING_SERVER_MODE_REQUIRED');
  system??=createWindowsAdoptionSystem();
  await system.assertNoHostLaunchers();
  const services=servicesFactory({registryFile:preview.source.physicalRegistry,policyFile});
  // ServiceManager.stop reuses request/ensure. Never permit that path to spawn
  // a replacement service if the old service disappeared during this repair.
  services.ensure=async id=>{const cap=await services.capabilities(id);if(!cap?.url)throw fail('ORIGINAL_SERVICE_DISAPPEARED');return cap;};
  const registryBefore=read(preview.source.physicalRegistry),installedFile=preview.files.find(f=>f.kind==='installed').source,installedBefore=read(installedFile);
  const normalizedRegistry=normalizeMetadataDocument(registryBefore),normalizedInstalled=normalizeMetadataDocument(installedBefore);
  if(normalizedRegistry.blocked.length||normalizedInstalled.blocked.length)throw fail('PATH_NORMALIZATION_BLOCKED');
  const oldNode=installedBefore.packages?.['node-runtime'],newNode=normalizedInstalled.document.packages?.['node-runtime'];
  const scopes={nodePaths:[oldNode,newNode].filter(Boolean).map(p=>path.join(p.root,p.entry)),entryPaths:ids.flatMap(id=>[registryBefore[id],normalizedRegistry.document[id]].filter(Boolean).map(c=>path.join(c.root,'server.mjs'))),electronExes:['warehouse','exporter'].flatMap(id=>[registryBefore[id]?.exe,normalizedRegistry.document[id]?.exe].filter(Boolean))};
  const assertQuiescent=async()=>{
    await system.assertNoHostLaunchers();assertNoPendingWrites(profile);
    for(const id of ids){if((await services.capabilities(id))?.url)throw fail('MODULE_RESTARTED_DURING_STOP');await assertNoLiveStartRecord(path.join(services.config(id).dataDir,'.integration-start.lock'),id,system);}
    if(await system.inspectGateway())throw fail('GATEWAY_RESTARTED_DURING_ADOPTION');
    if(await system.findManagedModuleProcesses(scopes)!==0)throw fail('MANAGED_MODULE_PROCESS_STILL_ALIVE');
  };
  const bindings=[],processes=new Map(),seenPids=new Set();
  assertInstallIdle(profile);assertNoPendingWrites(profile);
  for(const id of ids){
    const config=services.config(id),binding=captureLedgerBinding(id,config),cap=await services.capabilities(id);
    if(!cap?.url||cap.busy!==false||cap.workbench?.protocolVersion!==1||cap.dataSetId!==binding.dataSetId&&cap.workbench?.dataSetId!==binding.dataSetId||!Number.isSafeInteger(cap.pid))throw fail('MODULE_NOT_IDLE_OR_IDENTITY_CHANGED');
    if(fs.existsSync(path.join(config.dataDir,'.workbench-maintenance.json'))||cap.maintenance===true||cap.workbench?.maintenance===true)throw fail('MODULE_MAINTENANCE_PRESENT');
    const proc=await system.processInfo(cap.pid);if(!proc||proc.pid!==cap.pid||seenPids.has(cap.pid))throw fail('MODULE_PROCESS_CHANGED');seenPids.add(cap.pid);processes.set(id,proc);bindings.push(binding);
  }
  const health=await system.health();
  if(health.serverId!==preview.proposedMarker.content.serverId||health.dataSetId!==preview.proposedMarker.content.dataSetId)throw fail('GATEWAY_IDENTITY_CHANGED');
  const owner=validateGatewayOwner(await system.inspectGateway(),preview,normalizedInstalled.document,connection);
  verifyUnchanged(preview,policyFile,policyHash);
  const backupRoot=preview.backupPlan.directory,lockFile=path.join(profile,'modules','install.lock'),token=randomUUID(),writes=[],stopped=[];
  let ownedLock=false,backupCreated=false,gatewayStopped=false;
  const result={schemaVersion:1,ok:false,startedAt:new Date().toISOString(),metadataOnly:true,businessDataMovedCopiedOrRestored:false,configurationScope:'Reviewed Documents registry, existing physical installed.json, Documents marker',stoppedModules:stopped,restartRequired:true};
  try{
    fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,adoptionToken:token}),{flag:'wx',mode:0o600});ownedLock=true;
    verifyUnchanged(preview,policyFile,policyHash,token);assertNoPendingWrites(profile);
    fs.mkdirSync(path.dirname(backupRoot),{recursive:true});fs.mkdirSync(backupRoot);backupCreated=true;
    for(const item of preview.backupPlan.files){const bytes=fs.readFileSync(item.source);if(hash(bytes)!==item.sha256)throw fail('BACKUP_SOURCE_CHANGED');fs.writeFileSync(item.destination,bytes,{flag:'wx',mode:0o600});if(digestFile(item.destination)!==item.sha256)throw fail('BACKUP_VERIFICATION_FAILED');}
    fs.writeFileSync(path.join(backupRoot,'backup-manifest.json'),JSON.stringify({schemaVersion:1,metadataOnly:true,files:preview.backupPlan.files},null,2),{flag:'wx',mode:0o600});
    checkpoint('backups-complete');
    for(const id of stopOrder){
      verifyUnchanged(preview,policyFile,policyHash,token);assertNoPendingWrites(profile);
      const cap=await services.capabilities(id);if(!cap?.url||cap.pid!==processes.get(id).pid||cap.busy!==false)throw fail('MODULE_CHANGED_BEFORE_STOP');
      await services.stop(id);await system.waitForExit(processes.get(id));stopped.push(id);
    }
    assertNoPendingWrites(profile);
    const latest=validateGatewayOwner(await system.inspectGateway(),preview,normalizedInstalled.document,connection);
    if(latest.pid!==owner.pid||latest.startedAtTicks!==owner.startedAtTicks||latest.physicalEntry!==owner.physicalEntry)throw fail('GATEWAY_PROCESS_CHANGED');
    assertNoPendingWrites(profile);await system.stopGateway(latest);await system.waitForExit(latest);gatewayStopped=true;
    // A request may have raced the previous checks. No metadata is changed if
    // it left an uncertain operation or restarted a module before gateway exit.
    assertNoPendingWrites(profile);verifyUnchanged(preview,policyFile,policyHash,token);
    await assertQuiescent();
    for(const before of bindings)if(!isDeepStrictEqual(captureLedgerBinding(before.id,services.config(before.id)),before))throw fail('LEDGER_CHANGED_BEFORE_METADATA');
    checkpoint('services-stopped');
    await assertQuiescent();
    const registryTarget=preview.files.find(f=>f.kind==='registry').destination;
    function write(file,value,kind){
      const bytes=Buffer.from(JSON.stringify(value,null,2)),original=fs.existsSync(file)?fs.readFileSync(file):null;
      const expected=preview.backupPlan.files.find(item=>equalPath(item.source,file))?.sha256??null;
      if((original?hash(original):null)!==expected)throw fail('METADATA_TARGET_CHANGED');
      const entry={file,kind,original,newHash:hash(bytes)};writes.push(entry);atomic(file,bytes);if(digestFile(file)!==entry.newHash)throw fail('METADATA_READBACK_FAILED');checkpoint(kind+'-written');
    }
    write(registryTarget,normalizedRegistry.document,'registry');write(installedFile,normalizedInstalled.document,'installed');
    verifyAfterOwnWrites(preview,policyFile,policyHash,token,writes);
    for(const before of bindings)if(!isDeepStrictEqual(captureLedgerBinding(before.id,services.config(before.id)),before))throw fail('LEDGER_CHANGED_AFTER_METADATA');
    const identity=read(path.join(profile,'workbench-server','identity.json'));
    if(identity.serverId!==preview.proposedMarker.content.serverId||identity.dataSetId!==preview.proposedMarker.content.dataSetId)throw fail('GATEWAY_IDENTITY_CHANGED');
    await assertQuiescent();
    write(preview.proposedMarker.file,preview.proposedMarker.content,'marker');
    verifyAfterOwnWrites(preview,policyFile,policyHash,token,writes);
    await assertQuiescent();
    const location=getWorkbenchLocation(undefined,{home});
    if(!equalPath(location.profile,profile)||!equalPath(location.registryFile,registryTarget)||location.serverId!==identity.serverId||location.dataSetId!==identity.dataSetId)throw fail('MARKER_READBACK_FAILED');
    result.ok=true;result.finishedAt=new Date().toISOString();result.backupFiles=preview.backupPlan.files.length;result.ledgerIdentitiesRetained=bindings.map(b=>({module:b.id,dataSetIdDigest:hash(b.dataSetId)}));result.markerCommittedLast=true;result.gatewayStopped=gatewayStopped;
    fs.writeFileSync(path.join(backupRoot,'adoption-result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});return result;
  }catch(error){
    const conflicts=[];
    for(const entry of [...writes].reverse()){
      try{
        const current=fs.existsSync(entry.file)?digestFile(entry.file):null,original=entry.original?hash(entry.original):null;
        if(current===original)continue;
        if(current!==entry.newHash){conflicts.push(entry.kind);continue;}
        if(entry.original)atomic(entry.file,entry.original);else fs.unlinkSync(entry.file);
      }catch{conflicts.push(entry.kind);}
    }
    Object.assign(result,{finishedAt:new Date().toISOString(),code:error.code||'ADOPTION_FAILED',gatewayStopped,metadataRolledBack:conflicts.length===0,rollbackConflicts:conflicts,backupsRetained:backupCreated});
    if(backupCreated)try{fs.writeFileSync(path.join(backupRoot,'adoption-result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});}catch{}
    throw Object.assign(fail(result.code),{report:result});
  }finally{
    if(ownedLock)try{if(read(lockFile).adoptionToken===token)fs.unlinkSync(lockFile);}catch{}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==4||process.argv[2]!=='--apply'){process.stderr.write('Usage: node scripts/adopt-workbench-location.mjs --apply REVIEWED_PREVIEW.json\n');process.exitCode=2;}
  else try{const result=await adoptWorkbenchLocation(path.resolve(process.argv[3]));process.stdout.write(JSON.stringify(result)+'\n');}
  catch(error){process.stderr.write(JSON.stringify(error.report||{ok:false,code:error.code||'ADOPTION_FAILED',metadataOnly:true})+'\n');process.exitCode=1;}
}
