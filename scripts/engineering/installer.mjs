import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {sign,createPrivateKey,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPreview,createPreviewInstallerInclude,previewInstallerOptions} from '../build-agent-preview.mjs';
import {PRODUCT_MODULES} from '../../desktop/product/modules.mjs';
import {verifyCatalog,digest} from '../../desktop/modules/package-format.mjs';
import {zipFiles} from './zip.mjs';
import {deferredWarehouseFile,hostDependencyPaths} from './warehouse-extension.mjs';
import {trimShell,assertSlimShell} from './trim-shell.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function buildOnDemandInstaller(receipt){
  // Reuse the existing pinned strict scanner and original preview gate. Neither
  // signing nor packaging accepts an old scan from another source snapshot.
  const scanRoot=path.join(root,'.codex-artifacts/public-scan');fs.mkdirSync(scanRoot,{recursive:true});
  for(const name of ['scan-stage-public.mjs','gitleaks-v8.30.1.official.toml'])fs.copyFileSync(path.join(root,'scripts/public-scan',name),path.join(scanRoot,name));
  const scan=spawnSync(process.execPath,[path.join(scanRoot,'scan-stage-public.mjs'),receipt.stage],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  fs.writeFileSync(path.join(scanRoot,'last-run.log'),scan.stdout+'\n'+scan.stderr);
  if(scan.status!==0)throw Error('Strict payload scan failed; see '+path.join(scanRoot,'last-run.log'));
  const proof=JSON.parse(scan.stdout.trim().split(/\r?\n/).at(-1));
  const prepared=await buildPreview({stage:receipt.stage,electronDist:path.join(root,'apps/exporter/node_modules/electron/dist'),scanSummary:path.join(proof.evidenceDirectory,'summary.json'),layoutOnly:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(receipt.stage,'agent-beta-resources.json'))),version=prepared.metadata.version;
  const output=fs.mkdtempSync(path.join(root,'.codex-artifacts/engineering/release-')),assets=path.join(output,'assets');fs.mkdirSync(assets);
  const tag=`preview-${version}-${receipt.manifestSha256.slice(0,12)}`;
  const releaseUrl='https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/'+tag+'/';
  const extensionTag='warehouse-'+version+'-'+receipt.manifestSha256.slice(0,12);
  const extensionUrl='https://github.com/907609732/cainiao-inventory/releases/download/'+extensionTag+'/';
  const hostDependencies=hostDependencyPaths(JSON.parse(fs.readFileSync(path.join(receipt.stage,'package-lock.json'))));
  const packages=[];
  for(const module of PRODUCT_MODULES){
    const files=Object.keys(manifest.payloadHashes).filter(rel=>rel.startsWith('apps/'+module.id+'/'));
    const archive=module.id+'-'+version+'-'+receipt.manifestSha256.slice(0,12)+'.zip',file=path.join(assets,archive);
    const unpackedBytes=await zipFiles(receipt.stage,files,file);
    packages.push({id:module.id,version:manifest.modules[module.id].version,platform:'win32',arch:'x64',hostRange:'='+version,kind:module.surface==='window'?'electron':'service',entry:module.id==='warehouse'?'apps/warehouse/runtime/resources/app.asar':'apps/'+module.id+'/'+module.entry,archive,bytes:fs.statSync(file).size,unpackedBytes,sha256:await digest(file),url:(module.id==='warehouse'?extensionUrl:releaseUrl)+archive,dependencies:module.dependencies.map(id=>({id,range:'='+manifest.vendor.components.find(c=>c.id===id).version}))});
  }
  const vendorEnvelope=JSON.parse(fs.readFileSync(path.join(receipt.stage,'vendor/catalog.json')));
  const keys=JSON.parse(fs.readFileSync(path.join(receipt.stage,'desktop/launcher/public-keys.json')));
  const vendor=verifyCatalog(vendorEnvelope,keys,{hostVersion:version,platform:'win32',arch:'x64'});
  for(const component of manifest.vendor.components){
    const original=vendor.packages.find(p=>p.id===component.id);
    const spec={...original,hostRange:'='+version,url:(component.id==='browser-runtime'?extensionUrl:releaseUrl)+component.archive};
    fs.copyFileSync(path.join(receipt.stage,'vendor',component.archive),path.join(assets,component.archive));packages.push(spec);
  }
  const keyFile=process.env.LINGTU_MODULE_SIGNING_KEY||path.join(os.homedir(),'.codex/module-signing/lingtu-release-ed25519.pem');
  if(path.resolve(keyFile).toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('Signing key must remain outside the workspace');
  const key=createPrivateKey(fs.readFileSync(keyFile));if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 release key required');
  const payload=Buffer.from(JSON.stringify({schemaVersion:1,preview:true,version,releaseManifestSha256:receipt.manifestSha256,packages}));
  const envelope={format:'lingtu-catalog/v1',keyId:process.env.LINGTU_MODULE_SIGNING_KEY_ID||'lingtu-2026',payload:payload.toString('base64'),signature:sign(null,payload,key).toString('base64')};
  verifyCatalog(envelope,keys,{hostVersion:version,platform:'win32',arch:'x64'});
  const catalog=path.join(assets,'component-catalog.json');fs.writeFileSync(catalog,JSON.stringify(envelope,null,2));
  // NSIS's direct-file branch needs a short physical path. No junctions.
  const stagingRoot=path.join(os.homedir(),'.codex/installer-staging');fs.mkdirSync(stagingRoot,{recursive:true});
  const shell=fs.mkdtempSync(path.join(stagingRoot,'lite-'));
  const size={frozenPayloadBytes:0,basePayloadBytes:0,omittedWarehouseSourceBytes:0};
  for(const item of JSON.parse(fs.readFileSync(prepared.file,'utf8')).inventory){
    size.frozenPayloadBytes+=item.bytes??fs.statSync(path.join(prepared.prepackaged,...item.path.split('/'))).size;
    if(/^resources\/agent-runtime\/(?:apps|vendor|dependency-layers)\//.test(item.path))continue;
    const rel=item.path.replace(/^resources\/agent-runtime\//,'');
    if(deferredWarehouseFile(rel)){size.omittedWarehouseSourceBytes+=item.bytes??fs.statSync(path.join(prepared.prepackaged,...item.path.split('/'))).size;continue;}
    if(rel.startsWith('node_modules/')&&!hostDependencies.some(key=>rel.startsWith(key+'/')&&!('/'+rel.slice(key.length+1)).includes('/node_modules/')))continue;
    const source=path.join(prepared.prepackaged,...item.path.split('/'));
    if(await digest(source)!==item.sha256)throw Error('Frozen shell changed');
    size.basePayloadBytes+=fs.statSync(source).size;
    const target=path.join(shell,...item.path.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  }
  const runtime=path.join(shell,'resources/agent-runtime');fs.copyFileSync(catalog,path.join(runtime,'component-catalog.json'));
  fs.writeFileSync(path.join(runtime,'on-demand.json'),JSON.stringify({format:'lingtu-on-demand/v1',version,manifestSha256:receipt.manifestSha256,catalogSha256:await digest(catalog),optionalModules:['warehouse'],hostDependencyPaths:hostDependencies},null,2));
  const trim=trimShell(shell);assertSlimShell(shell);
  const artifactName=`WuchengAgentPreview-Setup-${version}-lite-x64.exe`,include=createPreviewInstallerInclude(output,shell);
  const config={appId:'com.wucheng.ecommerce.erp.v2.agentpreview',productName:'五成工作台 开发预览',executableName:'WuchengAgentPreview',artifactName,electronVersion:manifest.sharedElectron.version,directories:{output:assets},publish:null,npmRebuild:false,win:{target:[{target:'nsis',arch:['x64']}]},nsis:previewInstallerOptions(include)};
  const configFile=path.join(output,'builder.cjs');fs.writeFileSync(configFile,'module.exports='+JSON.stringify(config));
  const started=Date.now(),log=fs.openSync(path.join(output,'installer.log'),'wx');let result;
  try{result=spawnSync(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--projectDir',path.join(shell,'resources/app'),'--prepackaged',shell,'--config',configFile,'--win','--publish','never'],{cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,ELECTRON_BUILDER_COMPRESSION_LEVEL:process.env.ERP_COMPRESSION_LEVEL||'1'}});}finally{fs.closeSync(log);}
  if(result.status!==0)throw Error('Installer failed: '+path.join(output,'installer.log'));
  assertSlimShell(shell);
  const installer=path.join(assets,artifactName),files=[];
  for(const name of fs.readdirSync(assets).sort()){const file=path.join(assets,name);if(fs.statSync(file).isFile())files.push({name,bytes:fs.statSync(file).size,sha256:await digest(file)});}
  fs.writeFileSync(path.join(assets,'SHA256SUMS.txt'),files.map(f=>f.sha256+'  '+f.name).join('\n')+'\n');
  const report={ok:true,installer,shell,assets,tag,version,manifestSha256:receipt.manifestSha256,source:receipt.source,files,trim,size,elapsedMs:Date.now()-started,extensionTag,extensionRepository:'907609732/cainiao-inventory',extensionAssets:packages.filter(p=>p.url.startsWith(extensionUrl)).map(p=>p.archive),published:false,installed:false,integrationVerified:false,strictScan:path.join(proof.evidenceDirectory,'summary.json')};
  fs.writeFileSync(path.join(root,'.codex-artifacts/engineering/installer-current.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(output,'installer-result.json'),JSON.stringify(report,null,2));return report;
}
