// Native WSH shortcut handling; no app launch, database access or data migration.
// Default: inspect, back up exact .lnk bytes, and write a reviewable JSON proposal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {getWorkbenchLocation} from '../desktop/shared/workbench-location.mjs';

const require=createRequire(import.meta.url);
const OLD_NAME='灵兔 AI 电商平台买家订单导出工具';
const HOST_NAME='五成电子商务工作台';
const EXE='云仓库存同步.exe';
const fixedArguments='--cli extension-call --id=lingtu.desks --action=start --params-base64='+Buffer.from(JSON.stringify({desk:'exporter',show:true})).toString('base64url')+' --confirm-side-effect';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fileHash=file=>hash(fs.readFileSync(file));
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const fail=message=>{throw Error(message);};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
function localFile(file,extension){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.startsWith('\\\\')||/[\r\n\0"%]/.test(file)||file.includes('://')||extension&&path.extname(file).toLowerCase()!==extension||!fs.statSync(file).isFile())fail('Expected an existing absolute local '+(extension||'file'));
  return fs.realpathSync.native(file);
}

// Dynamic paths/arguments travel through JSON stdin, never shell interpolation.
const COM=String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$shell=New-Object -ComObject WScript.Shell
try {
  if($request.operation -eq 'inventory') {
    $links=@()
    foreach($folder in @([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('Programs'))) {
      foreach($name in @('灵兔 AI 电商平台买家订单导出工具','五成电子商务工作台')) {
        $file=Join-Path $folder ($name+'.lnk')
        if(Test-Path -LiteralPath $file -PathType Leaf) {
          $shortcut=$shell.CreateShortcut($file)
          $links += [pscustomobject]@{file=$file;name=$name;targetPath=$shortcut.TargetPath;arguments=$shortcut.Arguments;workingDirectory=$shortcut.WorkingDirectory;iconLocation=$shortcut.IconLocation;description=$shortcut.Description;hotkey=$shortcut.Hotkey;windowStyle=$shortcut.WindowStyle}
          [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
      }
    }
    [pscustomobject]@{links=$links}|ConvertTo-Json -Depth 10 -Compress
  } elseif($request.operation -eq 'read' -or $request.operation -eq 'stage') {
    if(!(Test-Path -LiteralPath $request.file -PathType Leaf)){throw 'Shortcut is missing'}
    $shortcut=$shell.CreateShortcut($request.file)
    if($request.operation -eq 'stage') {
      $shortcut.TargetPath=$request.after.targetPath
      $shortcut.Arguments=$request.after.arguments
      $shortcut.WorkingDirectory=$request.after.workingDirectory
      $shortcut.IconLocation=$request.after.iconLocation
      $shortcut.Description=$request.after.description
      $shortcut.Save()
    }
    [pscustomobject]@{targetPath=$shortcut.TargetPath;arguments=$shortcut.Arguments;workingDirectory=$shortcut.WorkingDirectory;iconLocation=$shortcut.IconLocation;description=$shortcut.Description;hotkey=$shortcut.Hotkey;windowStyle=$shortcut.WindowStyle}|ConvertTo-Json -Depth 10 -Compress
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  } else {throw 'Unsupported operation'}
} finally {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
`;
function invokeCOM(request){
  if(process.platform!=='win32')fail('Shortcut adoption requires Windows WSH');
  const executable=path.join(process.env.SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(COM,'utf16le').toString('base64')],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});
  if(result.status!==0||result.error)fail('Windows shortcut COM inspection failed; no application was launched');
  return JSON.parse(result.stdout.replace(/^\uFEFF/,'').trim());
}
function shortcutFields(value){return Object.fromEntries(['targetPath','arguments','workingDirectory','iconLocation','description','hotkey','windowStyle'].map(key=>[key,value[key]??(key==='windowStyle'?1:'')]));}
function inspectHost(target){
  const exe=localFile(target,'.exe');
  if(path.basename(exe)!==EXE||path.basename(path.dirname(exe))!=='wucheng-ecommerce-erp-v2'||path.basename(path.dirname(path.dirname(exe))).toLowerCase()!=='programs')fail('Workbench target is not the stable installed launcher');
  const asarFile=localFile(path.join(path.dirname(exe),'resources','app.asar'),'.asar'),asar=require('@electron/asar');
  const pkg=JSON.parse(asar.extractFile(asarFile,'package.json').toString('utf8'));
  if(pkg.name!=='wucheng-ecommerce-erp-v2')fail('Installed target is not the workbench product');
  const extension=asar.extractFile(asarFile,path.join('desktop','extensions','lingtu-desks','extension.mjs')).toString('utf8');
  const showSupported=/export\s+const\s+EXPORTER_SHOW_API_VERSION\s*=\s*1\s*;/.test(extension);
  return {executable:exe,version:pkg.version,executableSha256:fileHash(exe),asarFile,asarSha256:fileHash(asarFile),exporterShowApiVersion:showSupported?1:0};
}
function bindings(){
  const location=getWorkbenchLocation();
  if(location.source!=='marker')fail('An adopted Documents workbench location marker is required');
  const registry=json(location.registryFile),exporter=registry.exporter;
  if(exporter?.managed!==true||exporter.allowInitialize===true||!exporter.root||!exporter.dataDir)fail('Registered exporter must already be managed and bound to its original data');
  if(!fs.statSync(exporter.root).isDirectory()||!fs.statSync(exporter.dataDir).isDirectory())fail('Registered exporter code/data directory is missing; no empty data directory will be created');
  return {markerFile:location.markerFile,markerSha256:fileHash(location.markerFile),registryFile:location.registryFile,registrySha256:fileHash(location.registryFile),profile:location.profile,serverIdentityDigest:hash(location.serverId+'\n'+location.dataSetId),exporter:{version:exporter.version,root:exporter.root,dataDir:exporter.dataDir}};
}
export function inspectExporterShortcutAdoption(){
  const inventory=invokeCOM({operation:'inventory'}),old=inventory.links.filter(link=>link.name===OLD_NAME),hostLinks=inventory.links.filter(link=>link.name===HOST_NAME);
  if(!old.length||!hostLinks.length)fail('Existing exporter and workbench shortcuts are both required');
  const seen=new Set(),shortcuts=[];
  for(const link of old){
    const physical=localFile(link.file,'.lnk');if(seen.has(physical.toLowerCase()))continue;seen.add(physical.toLowerCase());
    const target=localFile(link.targetPath,'.exe');
    if(path.basename(target)!==OLD_NAME+'.exe'||path.basename(path.dirname(target))!=='lingtu-order-export'||link.arguments!=='')fail('Original exporter shortcut target or arguments are unexpected; refusing to record or overwrite them');
    shortcuts.push({file:link.file,physicalFile:physical,sourceSha256:fileHash(link.file),before:shortcutFields(link)});
  }
  for(const link of hostLinks)if(link.arguments!==''||!same(link.targetPath,hostLinks[0].targetPath))fail('Installed workbench shortcuts disagree or contain extra arguments');
  const host=inspectHost(hostLinks[0].targetPath),binding=bindings();
  const after={targetPath:host.executable,arguments:fixedArguments,workingDirectory:path.dirname(host.executable),iconLocation:host.executable+',0',description:'通过五成电子商务工作台打开原历史订单导出台'};
  return {schemaVersion:1,kind:'exporter-shortcut-adoption',previewOnly:true,generatedAt:new Date().toISOString(),readyToApply:host.exporterShowApiVersion===1,blocked:host.exporterShowApiVersion===1?[]:['Installed launcher does not yet expose EXPORTER_SHOW_API_VERSION=1; install the reviewed candidate and regenerate this proposal before applying.'],host,binding,shortcuts:shortcuts.map(item=>({...item,after:{...after,hotkey:item.before.hotkey,windowStyle:item.before.windowStyle}})),intent:{extension:'lingtu.desks',action:'start',params:{desk:'exporter',show:true},confirmation:'--confirm-side-effect'},safety:{businessDataMovedOrCopied:false,businessServicesStarted:false,globalEnvironmentChanged:false,shortcutsChanged:false,secretsInArguments:false},references:['https://learn.microsoft.com/en-us/troubleshoot/windows-client/admin-development/create-desktop-shortcut-with-wsh']};
}

export function prepareExporterShortcutAdoption({output}={}){
  const proposal=inspectExporterShortcutAdoption();
  const stamp=proposal.generatedAt.replaceAll(':','-');
  const proposalFile=path.resolve(output||path.join(os.homedir(),'Documents','LingtuWorkbench','shortcut-backups',stamp,'proposal.json'));
  if(path.extname(proposalFile).toLowerCase()!=='.json'||fs.existsSync(proposalFile)||proposalFile.startsWith('\\\\'))fail('Proposal must be a new local JSON file');
  const backupDirectory=proposalFile+'.backups';
  if(fs.existsSync(backupDirectory))fail('Backup directory already exists');
  fs.mkdirSync(backupDirectory,{recursive:true,mode:0o700});
  proposal.backups=proposal.shortcuts.map((item,index)=>{
    if(fileHash(item.file)!==item.sourceSha256)fail('An original shortcut changed during preview');
    const backup=path.join(backupDirectory,index+'-'+path.basename(item.file));fs.copyFileSync(item.file,backup,fs.constants.COPYFILE_EXCL);
    if(fileHash(backup)!==item.sourceSha256)fail('Shortcut backup verification failed');
    return {source:item.file,backup,sha256:item.sourceSha256};
  });
  const temporary=proposalFile+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(proposal,null,2),{flag:'wx',mode:0o600});
  if(fs.existsSync(proposalFile))fail('Proposal destination appeared during preview');
  fs.renameSync(temporary,proposalFile);
  return {proposalFile,readyToApply:proposal.readyToApply,blocked:proposal.blocked,shortcuts:proposal.shortcuts.length,backupsVerified:proposal.backups.length,shortcutsChanged:false,businessServicesStarted:false};
}

function reviewProjection(proposal){return {schemaVersion:proposal.schemaVersion,kind:proposal.kind,host:proposal.host,binding:proposal.binding,shortcuts:proposal.shortcuts,intent:proposal.intent};}
export function applyExporterShortcutAdoption(proposalFile){
  localFile(proposalFile,'.json');const proposal=json(proposalFile);
  if(proposal.schemaVersion!==1||proposal.kind!=='exporter-shortcut-adoption'||proposal.previewOnly!==true||proposal.readyToApply!==true||!Array.isArray(proposal.backups)||proposal.backups.length!==proposal.shortcuts?.length)fail('This proposal is incomplete or still blocked; regenerate and review it');
  const current=inspectExporterShortcutAdoption();
  if(!current.readyToApply||canonical(reviewProjection(proposal))!==canonical(reviewProjection(current)))fail('Shortcut, installed program, or registered data binding changed since review; regenerate the proposal');
  for(const [index,item]of proposal.shortcuts.entries()){
    const backup=proposal.backups[index];localFile(backup.backup,'.lnk');
    if(backup.source!==item.file||backup.sha256!==item.sourceSha256||fileHash(backup.backup)!==item.sourceSha256||same(backup.backup,item.file))fail('Reviewed original shortcut backup is invalid');
  }
  const lock=path.join(path.dirname(proposal.binding.markerFile),'.exporter-shortcut-adoption.lock');
  const lockFd=fs.openSync(lock,'wx',0o600),staged=[],written=[];
  try{
    fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    for(const item of proposal.shortcuts){
      const file=path.join(path.dirname(item.file),'.'+path.basename(item.file,'.lnk')+'.'+randomUUID()+'.staged.lnk');
      fs.copyFileSync(item.file,file,fs.constants.COPYFILE_EXCL);staged.push({file,item});
      const readBack=invokeCOM({operation:'stage',file,after:item.after});
      if(canonical(shortcutFields(readBack))!==canonical(item.after))fail('Staged shortcut did not retain the reviewed fields');
    }
    if(canonical(reviewProjection(proposal))!==canonical(reviewProjection(inspectExporterShortcutAdoption())))fail('A reviewed source changed before shortcut commit');
    for(const entry of staged){
      if(fileHash(entry.item.file)!==entry.item.sourceSha256)fail('Original shortcut changed during commit');
      fs.renameSync(entry.file,entry.item.file);written.push({item:entry.item,sha256:fileHash(entry.item.file)});
      if(canonical(shortcutFields(invokeCOM({operation:'read',file:entry.item.file})))!==canonical(entry.item.after))fail('Committed shortcut read-back failed');
    }
    if(canonical(bindings())!==canonical(proposal.binding)||canonical(inspectHost(proposal.host.executable))!==canonical(proposal.host))fail('Installed program/data binding changed during shortcut commit');
    const receiptFile=proposalFile+'.applied.json';
    fs.writeFileSync(receiptFile,JSON.stringify({schemaVersion:1,appliedAt:new Date().toISOString(),proposalSha256:fileHash(proposalFile),shortcuts:written.map(({item,sha256})=>({file:item.file,sha256})),originalBackupsRetained:true,businessServicesStarted:false,businessDataChanged:false},null,2),{flag:'wx',mode:0o600});
    return {ok:true,receiptFile,shortcutsChanged:written.length,businessServicesStarted:false,businessDataChanged:false};
  }catch(error){
    const conflicts=[];
    for(const {item,sha256}of written.reverse()){
      if(!fs.existsSync(item.file)||fileHash(item.file)!==sha256){conflicts.push(item.file);continue;}
      const backup=proposal.backups.find(entry=>entry.source===item.file),restore=item.file+'.'+randomUUID()+'.restore.lnk';
      fs.copyFileSync(backup.backup,restore,fs.constants.COPYFILE_EXCL);fs.renameSync(restore,item.file);
      if(fileHash(item.file)!==item.sourceSha256)conflicts.push(item.file);
    }
    if(conflicts.length)fail('Shortcut apply failed; an independently changed shortcut was not overwritten. Original backups remain for manual review.');
    throw error;
  }finally{
    for(const entry of staged)if(fs.existsSync(entry.file))fs.rmSync(entry.file);
    fs.closeSync(lockFd);fs.rmSync(lock);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);let result;
    if(args[0]==='--apply'&&args.length===2)result=applyExporterShortcutAdoption(path.resolve(args[1]));
    else if(args.length===0||args.length===2&&args[0]==='--output')result=prepareExporterShortcutAdoption({output:args[1]});
    else fail('Usage: node scripts/prepare-exporter-shortcut-adoption.mjs [--output NEW-PROPOSAL.json] | --apply REVIEWED-PROPOSAL.json');
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(error){process.stderr.write('Exporter shortcut preparation failed: '+error.message+'\n');process.exitCode=1;}
}
