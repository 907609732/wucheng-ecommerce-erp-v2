import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {withBetaServiceStartFence} from './data-maintenance.mjs';
import {assertPreviewPaths} from './isolation.mjs';
import {initializePreviewLedgers} from './preview-ledgers.mjs';
import {createActivationResourceOperation,verifyActivationResources,activationCancelled} from './activation-resources.mjs';
import {AGENT_RESOURCE_FORMAT_V1,AGENT_RESOURCE_FORMAT_V2} from './resource-layout.mjs';
export {verifyActivationResources} from './activation-resources.mjs';
const require=createRequire(import.meta.url),yauzl=require('yauzl');
const ids=['warehouse','purchase','sales','overview','exporter'];
const ledgers={warehouse:'workspace/data/erp.sqlite',purchase:'purchases.sqlite',sales:'sales.sqlite',overview:'overview.sqlite',exporter:'orders.sqlite'};
const inside=(root,file)=>{const r=path.relative(root,file);return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function noLinks(file){let p=path.parse(file).root;for(const part of file.slice(p.length).split(path.sep).filter(Boolean)){p=path.join(p,part);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('Beta 激活路径包含链接');}}
function unzip(zipFile,dest,operation){return new Promise((resolve,reject)=>yauzl.open(zipFile,{lazyEntries:true,validateEntrySizes:true},(err,zip)=>{if(err)return reject(err);let total=0,count=0;const fail=e=>{zip.close();reject(e);};zip.on('error',fail);zip.on('end',resolve);zip.on('entry',entry=>{try{operation.checkCancelled();}catch(error){return fail(error);}const name=entry.fileName.replaceAll('\\','/'),target=path.resolve(dest,name),mode=(entry.externalFileAttributes>>>16)&0xf000;if(!inside(dest,target)||name.includes(':')||mode===0xa000||++count>100000||(total+=entry.uncompressedSize)>4*1024**3)return fail(Error('压缩包内容不安全'));if(/\/$/.test(name)){fs.mkdirSync(target,{recursive:true});zip.readEntry();return;}fs.mkdirSync(path.dirname(target),{recursive:true});zip.openReadStream(entry,(error,input)=>{if(error)return fail(error);const output=fs.createWriteStream(target,{flags:'wx',mode:0o600});input.on('error',fail);output.on('error',fail);output.on('finish',()=>zip.readEntry());input.pipe(output);});});zip.readEntry();}));}
function findOne(root,name,operation){const hits=[];function walk(dir){operation.checkCancelled();for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Beta 资源包含链接');if(e.isDirectory())walk(f);else if(e.name.toLowerCase()===name.toLowerCase())hits.push(f);}}walk(root);if(hits.length!==1)throw Error('Beta 运行环境入口缺失或不唯一: '+name);return hits[0];}
async function fileManifest(root,operation,{component}={}){
 const output={};let processed=0;
 async function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  operation.checkCancelled();const file=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Beta 资源包含链接');
  if(e.isDirectory())await walk(file);
  else if(e.isFile()){output[path.relative(root,file).replaceAll('\\','/')]=operation.hashFile(file);await operation.checkpoint({phase:'verify',component,processed:++processed});}
  else throw Error('Beta 资源类型无效');
 }}
 await walk(root);return output;
}
async function receiptProgramsMatch(paths,programs,operation){
 for(const [dir,files]of Object.entries(programs)){
  const target=path.resolve(paths.programs,dir);
  if(!inside(paths.programs,target)||JSON.stringify(await fileManifest(target,operation,{component:dir.split(path.sep)[0]}))!==JSON.stringify(files))return false;
 }
 return true;
}
function sharedElectronFor(manifest,paths){
 if(manifest.format!==AGENT_RESOURCE_FORMAT_V2)return null;
 const shared=manifest.sharedElectron;
 if(!shared||shared.version!=='44.7.0'||shared.version!==paths.sharedElectronVersion||JSON.stringify(shared.components)!==JSON.stringify(['warehouse','exporter'])||typeof paths.sharedElectronExecutable!=='string'||!path.isAbsolute(paths.sharedElectronExecutable))throw Error('Beta 共享 Electron 未绑定可信打包宿主');
 noLinks(paths.sharedElectronExecutable);if(!fs.lstatSync(paths.sharedElectronExecutable).isFile()||process.versions.electron&&process.versions.electron!==shared.version)throw Error('Beta 共享 Electron 版本或程序文件无效');
 for(const id of shared.components){const runtime=manifest.modules?.[id]?.runtime;if(runtime?.kind!=='shared-electron'||runtime.app!=='runtime/resources/app.asar'||!/^[a-f0-9]{64}$/.test(runtime.sha256||'')||manifest.payloadHashes['apps/'+id+'/'+runtime.app]!==runtime.sha256)throw Error('Beta 共享 Electron 组件入口无效: '+id);}
 return shared;
}
/** Trusted host only: expectedManifestSha256 must be pinned by the packaged host. */
export function createAgentActivation({paths,resourcesDir,expectedManifestSha256,isBusy,signal,onProgress}={}){
 return async function activate(){if(signal?.aborted)throw activationCancelled();return withBetaServiceStartFence(paths,async()=>{
  const root=path.resolve(paths?.root||''),expected=path.resolve(process.env.LOCALAPPDATA||'',paths?.preview===true?'WuchengAgentBeta-preview':'WuchengAgentBeta'),res=path.resolve(resourcesDir||'');
  if(paths?.preview===true)assertPreviewPaths(paths);
  if(!process.env.LOCALAPPDATA||root!==expected||paths.registryFile!==path.join(root,'registry.json')||paths.programs!==path.join(root,'programs')||paths.data!==path.join(root,'data')||!/^[a-f0-9]{64}$/.test(expectedManifestSha256||'')||typeof isBusy!=='function')throw Error('Beta 激活配置未绑定');
  const operation=createActivationResourceOperation(res,{signal,onProgress}),sha=operation.hashFile;
  noLinks(root);noLinks(res);const manifestFile=path.join(res,'agent-beta-resources.json');noLinks(manifestFile);if(sha(manifestFile)!==expectedManifestSha256)throw Error('Beta 资源清单摘要不符');const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));if(![AGENT_RESOURCE_FORMAT_V1,AGENT_RESOURCE_FORMAT_V2].includes(manifest.format)||manifest.purchaseMobilePort!==27380||!manifest.payloadHashes)throw Error('Beta 资源清单无效');
  await verifyActivationResources(res,manifest,{operation});
  const sharedElectron=sharedElectronFor(manifest,paths);
  const receiptFile=path.join(paths.profile,'agent-beta-activation.json');noLinks(receiptFile);try{const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));if(receipt.manifestSha256===expectedManifestSha256&&sha(paths.registryFile)===receipt.registrySha256&&await receiptProgramsMatch(paths,receipt.programs,operation)){await operation.checkpoint({phase:'initialize'},{force:true});if(paths.preview===true)initializePreviewLedgers({paths,resourcesDir:res,manifest});operation.checkCancelled();onProgress?.({phase:'ready'});return {ready:true,reused:true,manifestSha256:expectedManifestSha256,installed:ids,missingData:ids.filter(id=>!fs.existsSync(path.join(paths.data,id,ledgers[id])))};}}catch(error){if(error.code!=='ENOENT')throw error;}
  if(await isBusy())throw Error('Beta 服务有活动任务，不能替换程序');
  const version=expectedManifestSha256.slice(0,16)+'-'+crypto.randomUUID(),records={},programRoots={};fs.mkdirSync(paths.programs,{recursive:true});
  for(const id of ids){const parent=path.join(paths.programs,id),dest=path.join(parent,version),prefix='apps/'+id+'/';noLinks(parent);fs.mkdirSync(parent,{recursive:true});fs.mkdirSync(dest);let count=0;const componentFiles=Object.entries(manifest.payloadHashes).filter(([rel])=>rel.startsWith(prefix));await operation.checkpoint({phase:'copy',component:id,processed:0,total:componentFiles.length},{force:true});for(const [rel,digest]of componentFiles){const source=path.resolve(res,...rel.split('/')),out=path.resolve(dest,...rel.slice(prefix.length).split('/'));if(!inside(dest,out))throw Error('Beta 资源路径越界');operation.sourceFile(source);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(source,out,fs.constants.COPYFILE_EXCL);if(sha(out)!==digest)throw Error('Beta 安装文件摘要不符');await operation.checkpoint({phase:'copy',component:id,processed:++count,total:componentFiles.length});}if(!count)throw Error('Beta 组件资源缺失: '+id);const componentVersion=manifest.modules?.[id]?.version;if(typeof componentVersion!=='string'||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(componentVersion))throw Error('Beta 组件版本无效: '+id);const native=['warehouse','exporter'].includes(id),shared=native&&sharedElectron?.components.includes(id);programRoots[id]=dest;records[id]={root:native?path.join(dest,'runtime'):dest,version:componentVersion,dataDir:path.join(paths.data,id),managed:true,allowInitialize:false,port:(paths.preview===true?27431:27331)+ids.indexOf(id),...(id==='purchase'?{mobilePort:paths.preview===true?27480:27380}:{}),...(native?{exe:shared?paths.sharedElectronExecutable:path.join(dest,'runtime',id==='warehouse'?'WuchengAgentBetaWarehouse.exe':'WuchengAgentBetaExporter.exe'),...(shared?{sharedElectron:true}:{})}:{})};if(native&&!fs.existsSync(shared?path.join(records[id].root,'resources','app.asar'):records[id].exe))throw Error('Beta 独立程序缺失: '+id);if(!native&&!fs.existsSync(path.join(dest,'server.mjs')))throw Error('Beta 服务入口缺失: '+id);}
  for(const component of manifest.vendor.components){if(!['node-runtime','browser-runtime'].includes(component.id)||typeof component.archive!=='string'||path.basename(component.archive)!==component.archive||manifest.payloadHashes['vendor/'+component.archive]!==component.sha256)throw Error('不允许激活未核验的运行环境');const parent=path.join(paths.programs,component.id),dest=path.join(parent,version),archive=path.join(res,'vendor',component.archive);noLinks(parent);fs.mkdirSync(parent,{recursive:true});fs.mkdirSync(dest);await operation.checkpoint({phase:'runtime',component:component.id},{force:true});await unzip(archive,dest,operation);programRoots[component.id]=dest;records[component.id]={root:dest,entry:findOne(dest,component.id==='node-runtime'?'node.exe':'chrome.exe',operation)};}
  if(!records['node-runtime']||!records['browser-runtime'])throw Error('Beta 固定运行环境不完整');for(const id of ids)records[id].nodePath=records['node-runtime'].entry;records.warehouse.browserPath=records['browser-runtime'].entry;for(const [id,db,env] of [['purchase','purchases.sqlite','PORT'],['sales','sales.sqlite','SALES_PORT'],['overview','overview.sqlite','OVERVIEW_PORT']])Object.assign(records[id],{db,env});
  if(await isBusy())throw Error('Beta 服务已开始执行任务，未切换注册表');noLinks(paths.registryFile);const programs={};for(const id of [...ids,'node-runtime','browser-runtime']){const dir=path.relative(paths.programs,programRoots[id]);programs[dir]=await fileManifest(programRoots[id],operation,{component:id});}operation.checkCancelled();const tmp=paths.registryFile+'.staging-'+crypto.randomUUID();fs.writeFileSync(tmp,JSON.stringify(Object.fromEntries(ids.map(id=>[id,records[id]])),null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,paths.registryFile);fs.mkdirSync(paths.profile,{recursive:true});const receiptTmp=receiptFile+'.staging-'+crypto.randomUUID();fs.writeFileSync(receiptTmp,JSON.stringify({manifestSha256:expectedManifestSha256,registrySha256:sha(paths.registryFile),programs}),{flag:'wx',mode:0o600});fs.renameSync(receiptTmp,receiptFile);await operation.checkpoint({phase:'initialize'},{force:true});if(paths.preview===true)initializePreviewLedgers({paths,resourcesDir:res,manifest});operation.checkCancelled();onProgress?.({phase:'ready'});return {ready:true,reused:false,manifestSha256:expectedManifestSha256,installed:ids,missingData:ids.filter(id=>!fs.existsSync(path.join(paths.data,id,ledgers[id])))};
 });};
}
