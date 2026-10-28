import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';
import {getWorkbenchLocation} from '../desktop/shared/workbench-location.mjs';
import {physicalPath,externalArchive,samePath,inside,hashFile as hash,archiveVerified,verifyDeletionTarget,verifySourceReplacement,refersToScope,managedProgramProtection} from './lib/workbench-file-safety.mjs';
const [mode,privateArchive,installationReport]=process.argv.slice(2);
if(!['preview','apply'].includes(mode)||!path.isAbsolute(privateArchive||''))throw Error('preview|apply ABSOLUTE_PRIVATE_ARCHIVE VERIFIED_INSTALL_REPORT');
const root=physicalPath(process.cwd()),dist=physicalPath(path.join(root,'dist')),location=getWorkbenchLocation(),archiveRoot=externalArchive(root,privateArchive);
const registry=JSON.parse(fs.readFileSync(location.registryFile)),protectedPaths=[root,physicalPath(location.profile),archiveRoot,...Object.values(registry).flatMap(c=>[c.root,c.dataDir,c.authProfileDir].filter(Boolean).map(p=>physicalPath(p,{allowMissing:true})))];
const protectedTrees=Object.values(registry).flatMap(c=>[c.root,c.dataDir,c.authProfileDir].filter(Boolean).map(p=>physicalPath(p,{allowMissing:true})));
const pathsOf=key=>Object.values(registry).map(c=>c[key]).filter(Boolean).map(p=>physicalPath(p,{allowMissing:true}));
const dataRoots=pathsOf('dataDir'),authRoots=pathsOf('authProfileDir'),programRoots=pathsOf('root');
if(protectedTrees.some(p=>samePath(p,archiveRoot)||inside(p,archiveRoot)||inside(archiveRoot,p))||samePath(location.profile,archiveRoot)||inside(location.profile,archiveRoot)||inside(archiveRoot,location.profile))throw Error('私有归档不能位于业务、程序或登录数据目录内');
const currentPayload=fs.existsSync(path.join(dist,'suite-payload-current.json'))?JSON.parse(fs.readFileSync(path.join(dist,'suite-payload-current.json'))).directory:null;
if(currentPayload)protectedTrees.push(physicalPath(currentPayload));
const targets=[];
for(const name of fs.readdirSync(dist)){
 if(!/^(?:launcher-app-|workbench-gateway-|tailnet-resource-|suite-build-|suite-payload-|cloud-module-|warehouse-candidate-)/.test(name))continue;
 const target=path.join(dist,name),stat=fs.lstatSync(target);if(!stat.isDirectory()||stat.isSymbolicLink())continue;
 const physical=physicalPath(target);if(currentPayload&&samePath(physical,currentPayload))continue;if(!inside(dist,physical)||protectedPaths.some(p=>samePath(p,physical)||inside(physical,p)))throw Error('清理目标触及受保护路径：'+name);targets.push({path:physical,kind:'reproducible-build'});
}
for(const name of ['win-unpacked','offline-0.9.1-YpOasY','modules']){const target=path.join(dist,name);if(fs.existsSync(target))targets.push({path:physicalPath(target),kind:'retired-distribution'});}
for(const name of fs.readdirSync(dist))if(/^CloudWarehouseInventorySync-(?:Setup|Portable)-[\d.]+-x64\.exe(?:\.blockmap)?$/.test(name)&&!name.includes('-0.11.0-'))targets.push({path:physicalPath(path.join(dist,name)),kind:'old-installer'});
const release=path.join(dist,'launcher-release');if(fs.existsSync(release))for(const name of fs.readdirSync(release))if((/^CloudWarehouseInventorySync-(?:Setup|Portable)-[\d.]+-x64\.exe(?:\.blockmap)?$/.test(name)||/^Lingtu-[\d.]+-Complete-Offline-Windows-x64\.zip$/.test(name))&&!name.includes('-0.11.0-'))targets.push({path:path.join(release,name),kind:'old-installer'});
const retiredRoots={purchase:path.join(os.homedir(),'Documents/ChatGPT/采购'),sales:path.join(os.homedir(),'Documents/ChatGPT/销售台'),overview:path.join(os.homedir(),'Documents/ChatGPT/采购/采购台和销售额台聚合'),exporter:path.join(os.homedir(),'Documents/ChatGPT/复刻买家历史订单导出软件')};
for(const originalBase of Object.values(retiredRoots)){if(!fs.existsSync(originalBase))continue;const base=physicalPath(originalBase);for(const name of ['node_modules','out','release','dist']){const target=path.join(base,name);if(fs.existsSync(target))targets.push({path:physicalPath(target),kind:'retired-source-cache',base});}}
const packageStore=path.join(location.profile,'modules/packages'),installed=JSON.parse(fs.readFileSync(path.join(location.profile,'modules/installed.json'))),currentRoots=new Set(Object.values(installed.packages).map(p=>path.resolve(p.root).toLowerCase()));
if(fs.existsSync(packageStore))for(const id of ['warehouse','purchase','sales','overview','exporter','node-runtime','browser-runtime']){const base=path.join(packageStore,id);if(!fs.existsSync(base))continue;for(const name of fs.readdirSync(base)){const target=path.join(base,name);if(!/^\d+\.\d+\.\d+-[a-f0-9-]{36}$/i.test(name)||currentRoots.has(path.resolve(target).toLowerCase()))continue;targets.push({path:physicalPath(target),kind:'retired-managed-program',base:physicalPath(base)});}}
for(const p of currentRoots)protectedTrees.push(physicalPath(p,{allowMissing:true}));
const verificationTargets=[];
for(const name of fs.readdirSync(dist))if(/^(?:review-|release-v|verified-v|finance-|purchase-sheet-|business-verification$|feature-help-verification$|integration-verification$|removal-verification$|name-check-user-data$|public-source-(?:audit|final)$)/.test(name)){
 const source=path.join(dist,name);if(!fs.statSync(source).isDirectory()||protectedPaths.some(p=>samePath(p,source)||inside(source,p)))continue;
 verificationTargets.push({path:physicalPath(source),kind:'archived-verification',archive:path.join(archiveRoot,'historical-verification',name)});
}
targets.push(...verificationTargets);
const readProcesses=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$r=@(Get-CimInstance Win32_Process | Select-Object ExecutablePath,CommandLine);ConvertTo-Json -InputObject $r -Compress"],{encoding:'utf8',windowsHide:true})||'[]');
const processRows=readProcesses();
for(const item of targets)item.runningReference=processRows.some(p=>refersToScope(p,item.kind==='retired-source-cache'?item.base:item.path));
const result={root,archive:archiveRoot,targets,currentPayloadProtected:currentPayload,materialArchive:path.join(archiveRoot,'historical-tmp'),mode};
if(mode==='preview'){console.log(JSON.stringify(result,null,2));process.exit(0);}
const report=JSON.parse(fs.readFileSync(installationReport,'utf8'));if(report.version!=='0.11.0'||report.ok!==true||report.dataVerified!==true||report.installedHashesMatch!==true)throw Error('清理需要0.11.0安装及数据核对通过报告');
const safety={protectedRoots:protectedPaths,protectedTrees};
const safetyFor=(item,activeReference=false)=>({...safety,base:item.base||dist,protectedTrees:managedProgramProtection(item.path,{kind:item.kind,profile:location.profile,currentRoots:[...currentRoots],programRoots,authRoots,dataRoots,protectedTrees,activeReference})});
// Complete every path/link preflight before deleting any old source file.
for(const item of targets)if(!item.runningReference)verifyDeletionTarget(item.path,safetyFor(item));
fs.mkdirSync(archiveRoot,{recursive:true});physicalPath(archiveRoot);const files=[];
const archive=(source,target)=>archiveVerified(source,target,files);
const rollback=path.join(release,'CloudWarehouseInventorySync-Setup-0.10.2-x64.exe');if(fs.existsSync(rollback))archive(rollback,path.join(archiveRoot,'rollback-0.10.2',path.basename(rollback)));
const tmp=path.join(root,'tmp');if(fs.existsSync(tmp))archive(tmp,result.materialArchive);
for(const item of verificationTargets)archive(item.path,item.archive);
fs.writeFileSync(path.join(archiveRoot,'archive-manifest.json'),JSON.stringify(files,null,2));
const sourceManifestFile=path.join(path.dirname(archiveRoot),'source-manifest.json'),sourceCleanupFile=path.join(archiveRoot,'source-cleanup-manifest.json');
const sourceCleanup=fs.existsSync(sourceCleanupFile)?JSON.parse(fs.readFileSync(physicalPath(sourceCleanupFile),'utf8')):[];
if(!Array.isArray(sourceCleanup))throw Error('旧源码清理记录需要核对');
if(fs.existsSync(sourceManifestFile)){
 const original=JSON.parse(fs.readFileSync(sourceManifestFile)),backupBase=path.dirname(sourceManifestFile);
 for(const item of original.files.filter(x=>['purchase','sales','overview','exporter'].includes(x.id))){
  const base=physicalPath(original.roots[item.id]),source=path.resolve(base,item.path),replacementRoot=path.join(root,'apps',item.id),replacement=path.resolve(replacementRoot,item.path),savedRoot=path.join(backupBase,'sources',item.id),saved=path.resolve(savedRoot,item.path);
  if(!samePath(base,retiredRoots[item.id]))throw Error('旧源码根不在本次明确接管的工作区');
  if(sourceCleanup.some(entry=>entry.id===item.id&&entry.path===item.path&&entry.removed))continue;
  if(processRows.some(p=>refersToScope(p,base))){sourceCleanup.push({id:item.id,path:item.path,retained:'running-original-workspace'});continue;}
  if(!inside(base,source)||!inside(replacementRoot,replacement)||!inside(savedRoot,saved))throw Error('旧源码或备份清单越界');
  if(!fs.existsSync(source)||!fs.existsSync(replacement)||!fs.statSync(replacement).isFile())continue;
  verifyDeletionTarget(source,{...safety,base});
  if(fs.existsSync(saved))physicalPath(saved);
  if(!fs.existsSync(saved)||hash(source)!==item.sha256||hash(saved)!==item.sha256){sourceCleanup.push({id:item.id,path:item.path,retained:'changed-or-backup-mismatch'});continue;}
  verifySourceReplacement({source,sourceRoot:base,replacement,replacementRoot,backup:saved,backupRoot:savedRoot,sha256:item.sha256});
  const entry={id:item.id,path:item.path,status:'verified-pending-delete',originalRetainedInPrivateBackup:true};sourceCleanup.push(entry);
  fs.writeFileSync(sourceCleanupFile,JSON.stringify(sourceCleanup,null,2));
  fs.unlinkSync(source);entry.removed=true;entry.status='removed';fs.writeFileSync(sourceCleanupFile,JSON.stringify(sourceCleanup,null,2));
 }
 fs.writeFileSync(sourceCleanupFile,JSON.stringify(sourceCleanup,null,2));
}
const retainedRunning=[];for(const item of targets){const scope=item.kind==='retired-source-cache'?item.base:item.path;if(readProcesses().some(p=>refersToScope(p,scope))){retainedRunning.push(item);continue;}const absolute=verifyDeletionTarget(item.path,safetyFor(item));if(item.kind==='archived-verification')for(const f of files.filter(file=>inside(absolute,file.source))){physicalPath(f.target);if(hash(f.source)!==f.sha256||hash(f.target)!==f.sha256)throw Error('删除前历史资料备份核对失败');}fs.rmSync(absolute,{recursive:true,force:false});}
// Every file is already copied and digest-checked; do not recursively delete tmp.
for(const f of files)if(inside(tmp,f.source)){verifyDeletionTarget(f.source,{...safety,base:tmp});physicalPath(f.target);if(hash(f.source)===f.sha256&&hash(f.target)===f.sha256)fs.unlinkSync(f.source);else throw Error('删除前历史资料备份摘要不符');}
const cleanupReport={version:'0.11.0',ok:true,removed:targets.length-retainedRunning.length,runningDirectoriesRetained:retainedRunning.length,replacedSourceFilesRemoved:sourceCleanup.filter(f=>f.removed).length,archivedFiles:files.length,archive:archiveRoot,remainingBusinessAndAuthenticationPathsRetained:true,checkedAt:new Date().toISOString()};fs.writeFileSync(path.join(archiveRoot,'cleanup-report.json'),JSON.stringify(cleanupReport,null,2));console.log(JSON.stringify(cleanupReport));
