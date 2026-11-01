const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');

const filters=['lingtu-tailnet.exe','manifest.json','NOTICE','LICENSES/**/*'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const allowedKeys=['schemaVersion','protocolVersion','platform','arch','file','bytes','sha256','version','tailscaleVersion'].sort();
const version=/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const licenseName=/^(?:LICENSE(?:\.[\w.-]+)?|COPYING(?:\.[\w.-]+)?|NOTICE(?:\.[\w.-]+)?|PATENTS)$/;
const failure=code=>Object.assign(Error(code),{code});

function validateTailnetResource(directory,{expected}={}){
 const root=path.resolve(directory),rootStat=fs.lstatSync(root);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw failure('TAILNET_RESOURCE_DIRECTORY_INVALID');
 const files=[];
 function visit(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
  const file=path.join(folder,entry.name),relative=path.relative(root,file).replaceAll('\\','/'),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw failure('TAILNET_RESOURCE_LINK_OR_SPECIAL_FILE');
  if(stat.isDirectory()){
   if(relative!=='LICENSES'&&!relative.startsWith('LICENSES/'))throw failure('TAILNET_RESOURCE_DIRECTORY_NOT_ALLOWLISTED');
   visit(file);continue;
  }
  if(!['lingtu-tailnet.exe','manifest.json','NOTICE'].includes(relative)&&!(relative.startsWith('LICENSES/')&&licenseName.test(entry.name)))throw failure('TAILNET_RESOURCE_FILE_NOT_ALLOWLISTED');
  const bytes=fs.readFileSync(file);files.push({path:relative,bytes:bytes.length,sha256:hash(bytes)});
 }}
 visit(root);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const byName=new Map(files.map(file=>[file.path,file]));
 if(!byName.has('lingtu-tailnet.exe')||!byName.has('manifest.json')||!byName.get('NOTICE')?.bytes||!files.some(file=>file.path.startsWith('LICENSES/')&&file.bytes>0))throw failure('TAILNET_RESOURCE_REQUIRED_FILE_MISSING');
 let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));}catch{throw failure('TAILNET_RESOURCE_MANIFEST_INVALID');}
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||JSON.stringify(Object.keys(manifest).sort())!==JSON.stringify(allowedKeys)||manifest.schemaVersion!==1||manifest.protocolVersion!==1||manifest.platform!=='win32'||manifest.arch!=='x64'||manifest.file!=='lingtu-tailnet.exe'||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<=0||!/^[a-f0-9]{64}$/.test(manifest.sha256||'')||!version.test(manifest.version||'')||!version.test(manifest.tailscaleVersion||''))throw failure('TAILNET_RESOURCE_MANIFEST_INVALID');
 const exe=byName.get(manifest.file);
 if(exe.bytes!==manifest.bytes||exe.sha256!==manifest.sha256)throw failure('TAILNET_RESOURCE_DIGEST_MISMATCH');
 const bytes=fs.readFileSync(path.join(root,manifest.file));
 if(bytes.length<64||bytes.toString('ascii',0,2)!=='MZ')throw failure('TAILNET_RESOURCE_NOT_WINDOWS_X64');
 const pe=bytes.readUInt32LE(0x3c);
 if(pe>bytes.length-26||bytes.toString('binary',pe,pe+4)!=='PE\0\0'||bytes.readUInt16LE(pe+4)!==0x8664||bytes.readUInt16LE(pe+24)!==0x20b)throw failure('TAILNET_RESOURCE_NOT_WINDOWS_X64');
 const fingerprint=hash(JSON.stringify(files));
 if(expected&&fingerprint!==expected.fingerprint)throw failure('TAILNET_RESOURCE_CHANGED_DURING_PACKAGING');
 return {root,manifest,files,fingerprint};
}

function copyTailnetResource(source,destination){
 const expected=validateTailnetResource(source),target=path.resolve(destination);
 if(fs.existsSync(target)&&fs.readdirSync(target).length)throw failure('TAILNET_RESOURCE_DESTINATION_NOT_EMPTY');
 fs.mkdirSync(target,{recursive:true});
 for(const file of expected.files){const output=path.join(target,file.path);fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(path.join(expected.root,file.path),output,fs.constants.COPYFILE_EXCL);}
 return validateTailnetResource(target,{expected});
}

function verifyTailnetVersion(resource){
 const checked=resource.manifest?resource:validateTailnetResource(resource);
 const result=spawnSync(path.join(checked.root,checked.manifest.file),['--version'],{windowsHide:true,shell:false,encoding:'utf8',timeout:15000,maxBuffer:65536});
 const prefix=`lingtu-tailnet ${checked.manifest.version} protocol/${checked.manifest.protocolVersion} tailscale/${checked.manifest.tailscaleVersion}`;
 if(result.status!==0||!result.stdout.trim().startsWith(prefix)||result.stderr.trim())throw failure('TAILNET_RESOURCE_VERSION_PROBE_FAILED');
 return result.stdout.trim();
}

function probePackagedTailnet({appOutDir,electronPath,expected}){
 const packaged=validateTailnetResource(path.join(appOutDir,'resources/tailnet-runtime'),{expected});
 const os=require('node:os'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-packaged-tailnet-'));
 try{
  const platform=/^(?:SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i;
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>platform.test(key)));
  env.ELECTRON_RUN_AS_NODE='1';env.PATH=process.env.SystemRoot?[path.join(process.env.SystemRoot,'System32'),process.env.SystemRoot].join(path.delimiter):'';
  const result=spawnSync(electronPath,['--no-global-search-paths',path.join(__dirname,'packaged-tailnet-probe.mjs'),path.join(appOutDir,'resources/app.asar'),packaged.root,temp],{cwd:temp,env,windowsHide:true,shell:false,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  if(result.status!==0)throw Object.assign(failure('PACKAGED_TAILNET_INERT_PROBE_FAILED'),{details:(result.stderr||result.error?.message||'').slice(0,16384)});
  const report=JSON.parse(result.stdout.trim());
  if(report.ok!==true||report.realStart!==false||report.allProductionDependenciesInsideAsar!==true||report.inertBackend!==true||report.developmentFixtureDirectoriesExcluded!==true)throw failure('PACKAGED_TAILNET_INERT_PROBE_INVALID');
  return report;
 }finally{
  const resolved=fs.realpathSync(temp),relative=path.relative(fs.realpathSync(os.tmpdir()),resolved);
  if(relative.includes(path.sep)||!relative.startsWith('lingtu-packaged-tailnet-'))throw failure('TAILNET_PROBE_CLEANUP_PATH_INVALID');
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}

module.exports={filters,validateTailnetResource,copyTailnetResource,verifyTailnetVersion,probePackagedTailnet};
