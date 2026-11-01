import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {materialize,readPlan,commonElectron} from '../agent-beta-stage.mjs';
import {suiteSourceDigests,suiteSourceDigest} from '../suite-source-digests.mjs';
import {globalSourceHash} from '../agent-beta-coverage.mjs';
import {synchronizeApproval} from '../sync-agent-approval.mjs';
import {auditStage,payloadHashes} from '../agent-beta-package-audit.mjs';
import {cloneFiles} from './files.mjs';
import {warehouseSource,overlayWarehouseSource} from './warehouse-extension.mjs';
import {PRODUCT_MODULE_IDS} from '../../desktop/product/modules.mjs';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=b=>createHash('sha256').update(b).digest('hex');
export function sourceIdentity(){return {warehouseExtension:warehouseSource().sha256,business:suiteSourceDigests(root),desktop:suiteSourceDigest(path.join(root,'desktop')),global:globalSourceHash()};}
const reportDir=path.join(root,'.codex-artifacts/engineering');
function run(file,args,options={}){const result=spawnSync(file,args,{cwd:root,windowsHide:true,stdio:'inherit',...options});if(result.status!==0)throw Error('Command failed: '+args.join(' '));return result;}
async function build(){
  fs.mkdirSync(reportDir,{recursive:true});
  const source=sourceIdentity(),started=Date.now(),approval=synchronizeApproval(root),stage=materialize(readPlan());
  overlayWarehouseSource(stage);
  const electron=commonElectron();
  run(process.execPath,[path.join(root,'node_modules/turbo/bin/turbo'),'run','build','--concurrency=2','--summarize','--env-mode=strict'],{env:{...process.env,WAREHOUSE_EXTENSION_SOURCE_SHA256:source.warehouseExtension,ERP_BUILD_STAGE:stage,ERP_BUILD_NODE:process.version,ERP_BUILD_PLATFORM:process.platform,ERP_BUILD_ARCH:process.arch,ERP_BUILD_ELECTRON:electron.version}});
  cloneFiles(path.join(root,'tooling/build-units/host/artifact/node_modules'),path.join(stage,'node_modules'));
  for(const id of PRODUCT_MODULE_IDS){const dest=path.join(stage,'apps',id);fs.rmSync(dest,{recursive:true,force:true});cloneFiles(path.join(root,'tooling/build-units',id,'artifact/app'),dest);}
  const manifestFile=path.join(stage,'agent-beta-resources.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));
  for(const id of ['warehouse','exporter']){const app='runtime/resources/app.asar';manifest.modules[id].runtime={kind:'shared-electron',app,sha256:hash(fs.readFileSync(path.join(stage,'apps',id,app)))};}
  if(JSON.stringify(source)!==JSON.stringify(sourceIdentity()))throw Error('Sources changed during build; candidate rejected');
  const {warehouseExtension,...hostSource}=source;manifest.sourceDigests=hostSource;manifest.warehouseExtensionSourceSha256=warehouseExtension;manifest.approvalSha256=approval.normalizedSha256;synchronizeApproval(stage);
  manifest.payloadHashes=payloadHashes(stage);fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
  const manifestSha256=hash(fs.readFileSync(manifestFile));
  fs.writeFileSync(path.join(stage,'desktop/business-host/packaged-manifest.json'),JSON.stringify({sha256:manifestSha256}));
  const audit=auditStage(stage);
  const turboRuns=path.join(root,'.turbo/runs');
  const summary=fs.existsSync(turboRuns)?fs.readdirSync(turboRuns).filter(f=>f.endsWith('.json')).map(f=>path.join(turboRuns,f)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]:null;
  const receipt={ok:true,stage,source,manifestSha256,elapsedMs:Date.now()-started,audit,turboSummary:summary,installerCreated:false,installed:false};
  fs.writeFileSync(path.join(reportDir,'build-current.json'),JSON.stringify(receipt,null,2));
  fs.writeFileSync(path.join(reportDir,'build-'+Date.now()+'.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));
}

const command=process.argv[2];
if(command==='dev'){
  // Development also uses the fixed preview identity, never the formal ledger.
  run(process.execPath,['tests/hybrid-source-harness.mjs','--launch','--debug']);
}else if(command==='build')await build();
else if(command==='installer'){
  const receipt=JSON.parse(fs.readFileSync(path.join(reportDir,'build-current.json'),'utf8'));
  if(!receipt.ok||JSON.stringify(receipt.source)!==JSON.stringify(sourceIdentity()))throw Error('Run npm run build for the current source before packaging');
  const {buildOnDemandInstaller}=await import('./installer.mjs');
  console.log(JSON.stringify(await buildOnDemandInstaller(receipt)));
}else throw Error('Use dev, build or installer');
