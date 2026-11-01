// Rebuild only the installer from a compacted, verified preview. No business build.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createPreviewInstallerInclude,previewInstallerOptions} from './build-agent-preview.mjs';
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function packageCompactPreview(layoutFile){
 const layout=JSON.parse(fs.readFileSync(layoutFile)),snapshot=path.resolve(layout.destination),root=path.resolve(import.meta.dirname,'..');
 if(layout.files>20000||layout.bytes>1100000000)throw Error('Preview layout exceeds the installation budget');
 for(const f of layout.inventory){const file=path.resolve(snapshot,...f.path.split('/'));if(!file.startsWith(snapshot+path.sep)||fs.realpathSync.native(file)!==file||file.length>=260||sha(file)!==f.sha256)throw Error('Compacted snapshot differs: '+f.path);}
 const meta=JSON.parse(fs.readFileSync(path.join(snapshot,'resources/agent-preview-package.json')));
 if(meta.appId!=='com.wucheng.ecommerce.erp.v2.agentpreview'||meta.profileRootName!=='WuchengAgentBeta-preview'||meta.preview!==true||meta.stageManifestSha256!==layout.manifestSha256)throw Error('Compacted preview identity differs');
 if(fs.readFileSync(path.join(root,'apps/exporter/node_modules/electron/dist/version'),'utf8').trim()!=='44.7.0'||sha(path.join(snapshot,'WuchengAgentPreview.exe'))!==sha(path.join(root,'apps/exporter/node_modules/electron/dist/electron.exe')))throw Error('Electron runtime differs');
 const base=path.join(root,'.codex-artifacts/agent-preview-builds');fs.mkdirSync(base,{recursive:true});const output=fs.mkdtempSync(path.join(base,'compact-preview-'));
 const config={appId:meta.appId,productName:'五成工作台 开发预览',executableName:'WuchengAgentPreview',artifactName:'WuchengAgentPreview-Setup-'+meta.version+'-optimized-x64.exe',electronVersion:'44.7.0',directories:{output:path.join(output,'output')},publish:null,npmRebuild:false,win:{target:[{target:'nsis',arch:['x64']}]},nsis:previewInstallerOptions(createPreviewInstallerInclude(output,snapshot))};
 const file=path.join(output,'preview-builder.cjs');fs.writeFileSync(file,'module.exports='+JSON.stringify(config));const log=fs.openSync(path.join(output,'builder.log'),'wx'),started=Date.now();let result;
 try{result=spawnSync(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--projectDir',path.join(snapshot,'resources/app'),'--prepackaged',snapshot,'--config',file,'--win','--publish','never'],{cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,ELECTRON_BUILDER_COMPRESSION_LEVEL:'1'}});}finally{fs.closeSync(log);}
 const exe=path.join(output,'output',config.artifactName),receipt={file:exe,exitCode:result.status,elapsedMs:Date.now()-started,sourceCommit:meta.sourceCommit,manifestSha256:meta.stageManifestSha256,installerConfig:config,installed:false,launched:false};
 if(result.status===0){receipt.bytes=fs.statSync(exe).size;receipt.sha256=sha(exe);}fs.writeFileSync(path.join(output,'installer-result.json'),JSON.stringify(receipt,null,2));if(result.status!==0)throw Error('Installer build failed: '+output);return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename)console.log(JSON.stringify(packageCompactPreview(process.argv[2])));
