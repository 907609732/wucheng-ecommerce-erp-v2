// Repackage an explicitly frozen preview without compiling or changing business code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {previewInstallerOptions,createPreviewInstallerInclude} from './build-agent-preview.mjs';

const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'.codex-artifacts/agent-preview-builds');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const buffer=Buffer.allocUnsafe(1024*1024);
function sha(file){const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}}
function physical(file){let cursor=path.parse(file).root;for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())throw Error('Frozen input contains a link');}if(path.relative(file,fs.realpathSync.native(file))!=='')throw Error('Frozen input redirected');}
const inside=(parent,file)=>{const r=path.relative(parent,file);return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};

export function rebuildInstaller(frozen){
 if(!path.isAbsolute(frozen)||!inside(base,frozen)||path.basename(frozen)!=='prepackaged')throw Error('An absolute frozen preview input is required');
 physical(frozen);
 const resources=path.join(frozen,'resources'),meta=read(path.join(resources,'agent-preview-package.json')),app=read(path.join(resources,'app/package.json'));
 if(meta.preview!==true||meta.verifiedFullBeta!==false||meta.appId!=='com.wucheng.ecommerce.erp.v2.agentpreview'||meta.profileRootName!=='WuchengAgentBeta-preview'||meta.runtimeRootName!=='agent-runtime'||app.name!=='wucheng-agent-preview'||app.version!==meta.version||app.main!=='preview-entry.mjs')throw Error('Frozen preview identity is invalid');
 const runtime=path.join(resources,'agent-runtime'),manifestFile=path.join(runtime,'agent-beta-resources.json'),manifest=read(manifestFile);
 if(sha(manifestFile)!==meta.stageManifestSha256||read(path.join(runtime,'desktop/agent-host/packaged-manifest.json')).sha256!==meta.stageManifestSha256)throw Error('Frozen resource pin differs');
 const dist=path.join(root,'apps/exporter/node_modules/electron/dist'),version=fs.readFileSync(path.join(dist,'version'),'utf8').trim();
 if(version!=='44.7.0'||manifest.sharedElectron.version!==version||sha(path.join(frozen,'WuchengAgentPreview.exe'))!==sha(path.join(dist,'electron.exe')))throw Error('Electron distribution/version differs');
 const output=fs.mkdtempSync(path.join(base,'installer-repair-')),stagingBase=path.join(os.homedir(),'.codex/installer-staging');
 fs.mkdirSync(stagingBase,{recursive:true});physical(stagingBase);
 // makensis 3.0.4.1 still opens File /r inputs through MAX_PATH-limited APIs.
 // Keep the immutable snapshot in a short real directory, never a junction.
 const staging=fs.mkdtempSync(path.join(stagingBase,'preview-')),prepackaged=path.join(staging,'payload'),inventory=[];
 fs.mkdirSync(prepackaged);
 function copy(dir,dest){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const from=path.join(dir,entry.name),to=path.join(dest,entry.name);if(entry.isSymbolicLink())throw Error('Frozen payload contains a link');if(entry.isDirectory()){fs.mkdirSync(to);copy(from,to);}else if(entry.isFile()){fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);const digest=sha(from);if(sha(to)!==digest)throw Error('Snapshot copy differs');inventory.push({path:path.relative(frozen,from).replaceAll('\\','/'),bytes:fs.statSync(from).size,sha256:digest});if(inventory.length%8192===0)console.log(JSON.stringify({phase:'snapshot',files:inventory.length}));}else throw Error('Unexpected frozen file type');}}
 copy(frozen,prepackaged);
 const measured=new Map(inventory.map(item=>[item.path,item.sha256]));
 for(const [relative,digest] of Object.entries(manifest.payloadHashes)){if(relative.includes('\\')||relative.includes(':')||relative.split('/').some(p=>!p||p==='.'||p==='..')||measured.get('resources/agent-runtime/'+relative)!==digest)throw Error('Frozen business payload no longer matches its manifest: '+relative);}
 for(const [relative,digest] of [['resources/app/package.json',meta.overlays.package.after],['resources/app/package-lock.json',meta.overlays.packageLock.after],['resources/app/preview-entry.mjs',meta.overlays.entry.sha256]])if(measured.get(relative)!==digest)throw Error('Frozen shell overlay differs');
 // Keep the canonical engine entry intact; expose the documented packaging path.
 const harnessSource=path.join(prepackaged,'resources/agent-runtime/desktop/agent-runtime/hermes-bootstrap.py'),harness=path.join(prepackaged,'resources/agent-engines/hermes-bootstrap.py');
 fs.mkdirSync(path.dirname(harness),{recursive:true});fs.copyFileSync(harnessSource,harness,fs.constants.COPYFILE_EXCL);
 if(inventory.some(item=>path.join(prepackaged,...item.path.split('/')).length>=260))throw Error('NSIS source path exceeds MAX_PATH; choose a shorter staging root');
 const include=createPreviewInstallerInclude(output,prepackaged),artifactName='WuchengAgentPreview-Setup-'+meta.version+'-installer-repair-x64.exe';
 const config={appId:meta.appId,productName:'五成工作台 开发预览',executableName:'WuchengAgentPreview',artifactName,electronVersion:version,directories:{output:path.join(output,'output')},publish:null,npmRebuild:false,win:{target:[{target:'nsis',arch:['x64']}]},nsis:previewInstallerOptions(include)};
 const configFile=path.join(output,'preview-builder.cjs');fs.writeFileSync(configFile,'module.exports='+JSON.stringify(config),{flag:'wx'});
 const inputs={source:frozen,prepackaged,applicationSourceCommit:meta.sourceCommit,stageManifestSha256:meta.stageManifestSha256,electronVersion:version,electronSha256:sha(path.join(frozen,'WuchengAgentPreview.exe')),inventory,compatibilityOverlay:{path:'resources/agent-engines/hermes-bootstrap.py',sha256:sha(harness)},installerConfigSha256:sha(configFile),businessCodeChanged:false};
 fs.writeFileSync(path.join(output,'verified-frozen-inputs.json'),JSON.stringify(inputs,null,2),{flag:'wx'});
 console.log(JSON.stringify({phase:'building',output,files:inventory.length,bytes:inventory.reduce((n,f)=>n+f.bytes,0)}));
 const log=fs.openSync(path.join(output,'builder.log'),'wx'),started=Date.now();let result;
 try{result=spawnSync(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--projectDir',path.join(prepackaged,'resources/app'),'--prepackaged',prepackaged,'--config',configFile,'--win','--publish','never'],{cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,ELECTRON_BUILDER_COMPRESSION_LEVEL:'1'}});}finally{fs.closeSync(log);}
 const file=path.join(output,'output',artifactName),receipt={output,prepackaged,file,applicationSourceCommit:meta.sourceCommit,installerConfig:config,exitCode:result.status,signal:result.signal,error:result.error?.code||null,elapsedMs:Date.now()-started,installed:false,launched:false};
 if(result.status===0){receipt.bytes=fs.statSync(file).size;receipt.sha256=sha(file);}
 fs.writeFileSync(path.join(output,'installer-result.json'),JSON.stringify(receipt,null,2));
 if(result.status!==0)throw Error('Installer build failed: '+path.join(output,'builder.log'));
 return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename))console.log(JSON.stringify(rebuildInstaller(process.argv[2])));
