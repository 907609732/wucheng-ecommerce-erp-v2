import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {classifySecretFinding,classificationPolicySha256} from './agent-beta-scan-classification.mjs';

const root=path.resolve(import.meta.dirname,'..');
const scannerSha256='363cab9a83014379a05a3ae1a9a26d73113c0f6631923c0f53e0b2e1617af2a8';
const rulesSha256='e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf';
const scanConfigSha256='ebf46a58b5d6ed45d3260602db2713f31732ec466607dc8483473504ce09e45e';
const slash=value=>value.replaceAll('\\','/');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const inside=(base,file)=>{const rel=path.relative(base,file);return !!rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function digest(file){const h=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024);try{let size;while((size=fs.readSync(fd,buffer,0,buffer.length,null))>0)h.update(buffer.subarray(0,size));}finally{fs.closeSync(fd);}return h.digest('hex');}
function noLinks(file){let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Linked preview input forbidden');}}
function boundedInput(base,file){if(!path.isAbsolute(file))throw Error('Preview inputs must use absolute paths');const resolved=path.resolve(file);if(!inside(base,resolved))throw Error('Preview input is outside its allowed root');noLinks(resolved);const real=fs.realpathSync(resolved);if(!inside(base,real))throw Error('Preview input resolves outside its allowed root');return real;}
function gitCommit(){const result=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});if(result.status!==0||!/^\s*[a-f0-9]{40}\s*$/.test(result.stdout||''))throw Error('Current source commit unavailable');const builderState=spawnSync('git',['diff','--quiet','HEAD','--','scripts/build-agent-preview.mjs'],{cwd:root,windowsHide:true});if(builderState.status!==0)throw Error('Preview builder changed after the source freeze');return result.stdout.trim();}

export function assertPublicScanBinding(proof,{stage,manifestSha256,sourceCommit,sourceDigests}){
 if(proof?.ok!==true||proof.scope!=='isolated-beta'||proof.execution!=='stage-public-scan'||proof.error!==null||![0,1].includes(proof.scannerExitCode)||proof.scannerVersion!=='8.30.1'||proof.secretScansComplete!==true||proof.violations!==0||proof.needsReview!==0||proof.audit?.ok!==true||proof.unresolvedSecretFindings!==0||!Number.isSafeInteger(proof.classifiedFalsePositiveFindings)||proof.classifiedFalsePositiveFindings<0)throw Error('Strict public scan is missing, failed or incomplete');
 if((proof.scannerExitCode===0)!==(proof.classifiedFalsePositiveFindings===0))throw Error('Raw secret scanner exit/count evidence is inconsistent');
 if(proof.stage!==stage||proof.stageManifestSha256!==manifestSha256||proof.sourceCommit!==sourceCommit||!same(proof.sourceDigests,sourceDigests)||!same(proof.currentSourceDigests,sourceDigests))throw Error('Strict public scan is stale or bound to another source/stage');
 if(proof.officialRuleSha256!==rulesSha256||proof.strictConfigSha256!==scanConfigSha256)throw Error('Unknown strict public scan policy');
 if(proof.classificationPolicySha256!==classificationPolicySha256||!/^[a-f0-9]{64}$/.test(proof.payloadInventorySha256||''))throw Error('Unknown semantic classification policy or payload inventory');
 const c=proof.counts;
 if(!c||!(c.stageFiles>0)||c.sqliteMagicStageFilesChecked!==c.stageFiles||!(c.asarFiles>=2)||!(c.asarFilesExtracted>0)||c.sqliteMagicAsarFilesChecked!==c.asarFilesExtracted||!(c.asarIntegrityChecked>0)||!(c.vendorZipEntries>0)||!(c.sqliteMagicVendorEntriesChecked>0)||!(c.vendorTextExtracted>0))throw Error('Strict scan archive/SQLite coverage is incomplete');
}

export function verifiedPayloadMap(inventory,manifest){
 if(!Array.isArray(inventory)||!manifest.payloadHashes||typeof manifest.payloadHashes!=='object'||Array.isArray(manifest.payloadHashes))throw Error('Measured payload inventory missing');
 const measured=new Map();
 for(const item of inventory){checkedPayloadRelative(item.path);if(measured.has(item.path)||!/^[a-f0-9]{64}$/.test(item.sha256||'')||!Number.isSafeInteger(item.bytes)||item.bytes<0)throw Error('Measured payload inventory entry is invalid');measured.set(item.path,item.sha256);}
 const verified=new Map();for(const [relative,expected]of Object.entries(manifest.payloadHashes)){checkedPayloadRelative(relative);if(!/^[a-f0-9]{64}$/.test(expected)||measured.get(relative)!==expected)throw Error('Measured payload inventory differs from audited manifest');verified.set(relative,expected);}
 return verified;
}

export function replaySecretClassifications({raw,records,scan,stage,scanRoot,verifiedPayloadHashes}){
 if(!Array.isArray(raw)||!Array.isArray(records)||raw.length!==records.length||scan.findings!==raw.length||![0,1].includes(scan.exitCode)||scan.signal!==null||scan.spawnErrorCode!==null||(raw.length===0?scan.exitCode!==0:scan.exitCode!==1))throw Error('Raw secret scanner execution is inconsistent or failed');
 let classified=0,unresolved=0;
 for(let index=0;index<raw.length;index++){
  const finding=raw[index];if(typeof finding.Fingerprint!=='string'||!finding.Fingerprint||typeof finding.File!=='string')throw Error('Raw finding provenance missing');
  const file=boundedInput(scanRoot,finding.File),classification=classifySecretFinding({finding,file,stage,verifiedPayloadHashes});
  const fingerprintSha256=createHash('sha256').update(finding.Fingerprint).digest('hex');
  if(!isDeepStrictEqual(records[index],{index,fingerprintSha256,classification}))throw Error('Secret finding classification does not replay exactly');
  if(classification===null)unresolved++;else classified++;
 }
 if(scan.classifiedFalsePositives!==classified||scan.unresolvedFindings!==unresolved||classified+unresolved!==scan.findings)throw Error('Secret classification counts differ from raw findings');
 if(unresolved)throw Error('Unresolved secret findings block preview packaging');
 return {classified,unresolved,rawExitCode:scan.exitCode};
}

function verifyScanFiles(summaryFile,proof,{stage,manifest}){
 const directory=path.dirname(summaryFile),scannerDirectory=path.dirname(directory);
 const checked=name=>{const file=path.join(directory,name);noLinks(file);if(!fs.statSync(file).isFile())throw Error('Strict scanner evidence file missing');return file;};
 for(const name of ['violations.json','needs-review.json']){const entries=json(checked(name));if(!Array.isArray(entries)||entries.length)throw Error('Strict scanner has unresolved findings');}
 for(const [file,expected] of [[path.join(scannerDirectory,'scan-stage-public.mjs'),scannerSha256],[path.join(scannerDirectory,'gitleaks-v8.30.1.official.toml'),rulesSha256],[checked('gitleaks.toml'),proof.strictConfigSha256]]){noLinks(file);if(digest(file)!==expected)throw Error('Strict scanner or rules provenance changed');}
 const inventory=checked('payload-inventory.json');if(digest(inventory)!==proof.payloadInventorySha256)throw Error('Measured payload inventory file changed');
 const inventoryRows=json(inventory);if(!Array.isArray(inventoryRows)||inventoryRows.length!==proof.counts.stageFiles)throw Error('Measured inventory file count differs from actual scan');
 const verifiedPayloadHashes=verifiedPayloadMap(inventoryRows,manifest);
 const scans=json(checked('gitleaks-scanners.json'));
 if(!Array.isArray(scans)||scans.length!==2)throw Error('Both actual-stage and archive secret scans are required');
 let totalClassified=0,totalUnresolved=0,rawExitCode=0;
 for(const name of ['actual-stage','extracted-archive-files']){
  const scan=scans.find(item=>item.name===name);
  if(!scan||scan.report!==`gitleaks-${name}.redacted.json`)throw Error('A strict secret scanner report is missing');
  const raw=json(checked(scan.report)),records=json(checked(`gitleaks-${name}.classified.json`));
  const result=replaySecretClassifications({raw,records,scan,stage,scanRoot:name==='actual-stage'?stage:path.join(directory,'extracted'),verifiedPayloadHashes});
  const minimal=json(checked(`gitleaks-${name}.findings.json`));if(!Array.isArray(minimal)||minimal.length!==raw.length||minimal.some((entry,index)=>entry.fingerprintSha256!==records[index].fingerprintSha256))throw Error('Minimal finding report differs from its raw findings');
  totalClassified+=result.classified;totalUnresolved+=result.unresolved;rawExitCode=Math.max(rawExitCode,result.rawExitCode);
 }
 if(totalClassified!==proof.classifiedFalsePositiveFindings||totalUnresolved!==proof.unresolvedSecretFindings||rawExitCode!==proof.scannerExitCode)throw Error('Summary does not preserve actual raw scanner/classification results');
}

async function validateInputs({stage:stageInput,electronDist:electronInput,scanSummary:summaryInput}){
 const stage=boundedInput(path.join(root,'dist/agent-beta/stages'),stageInput);
 const scanSummary=boundedInput(path.join(root,'.codex-artifacts'),summaryInput);
 const canonicalElectron=path.join(root,'node_modules/electron/dist');
 if(!path.isAbsolute(electronInput)||path.resolve(electronInput)!==canonicalElectron)throw Error('Use the repository locked Electron distribution');
 noLinks(canonicalElectron);const electronDist=fs.realpathSync(canonicalElectron),electronPackage=json(path.join(root,'node_modules/electron/package.json'));
 const lock=json(path.join(root,'package-lock.json'));
 if(electronPackage.name!=='electron'||electronPackage.version!==lock.packages?.['node_modules/electron']?.version||fs.readFileSync(path.join(electronDist,'version'),'utf8').trim().replace(/^v/,'')!==electronPackage.version||!fs.existsSync(path.join(electronDist,'electron.exe')))throw Error('Locked Electron runtime is incomplete or mismatched');
 const {suiteSourceDigests,suiteSourceDigest}=await import('./suite-source-digests.mjs');
 const {globalSourceHash}=await import('./agent-beta-coverage.mjs');
 const sourceDigests={business:suiteSourceDigests(root),desktop:suiteSourceDigest(path.join(root,'desktop')),global:globalSourceHash()},sourceCommit=gitCommit();
 const manifest=json(path.join(stage,'agent-beta-resources.json')),manifestSha256=digest(path.join(stage,'agent-beta-resources.json'));
 if(!same(manifest.sourceDigests,sourceDigests))throw Error('Source changed since staging; prepare a new current stage');
 const proof=json(scanSummary);assertPublicScanBinding(proof,{stage,manifestSha256,sourceCommit,sourceDigests});
 const {auditStage}=await import('./agent-beta-package-audit.mjs');const audit=auditStage(stage);
 verifyScanFiles(scanSummary,proof,{stage,manifest});
 const pkg=json(path.join(stage,'package.json')),launcher=json(path.join(stage,'desktop/launcher/package.json'));
 if(!/^\d+\.\d+\.\d+$/.test(pkg.version||'')||launcher.version!==pkg.version)throw Error('Preview must use the frozen stage version');
 for(const rel of ['workbench-gateway/desktop/agent-runtime/mcp-entry.mjs','workbench-gateway/desktop/agent-runtime/hermes-bootstrap.py','apps/purchase/server.mjs','apps/sales/server.mjs','apps/overview/server.mjs','apps/purchase/public','apps/sales/public','apps/overview/public','apps/exporter/out/main/preview-ledger.js','apps/warehouse/runtime/WuchengAgentBetaWarehouse.exe','apps/exporter/runtime/WuchengAgentBetaExporter.exe'])if(!fs.existsSync(path.join(stage,rel)))throw Error('Complete preview resource missing: '+rel);
 for(const id of ['purchase','sales','overview','exporter'])if(!fs.existsSync(path.join(stage,'apps',id,'node_modules')))throw Error('Frozen production dependencies missing: '+id);
 return {stage,electronDist,electronVersion:electronPackage.version,scanSummary,scanSummarySha256:digest(scanSummary),manifest,manifestSha256,sourceCommit,sourceDigests,version:pkg.version,audit};
}

export const previewEntry="process.env.LINGTU_AGENT_PREVIEW='1';\nawait import('./desktop/launcher/main.mjs');\n";
function copyTree(source,dest,{host=false,base=source}={}){
 fs.cpSync(source,dest,{recursive:true,filter:file=>{
  const rel=slash(path.relative(base,file));if(fs.lstatSync(file).isSymbolicLink())throw Error('Linked preview payload forbidden');
  if(rel.split('/').includes('.bin'))return false;
  if(host&&(/^(?:vendor|workbench-gateway)(?:\/|$)/.test(rel)||rel==='agent-beta-resources.json'||/^apps\/[^/]+\/(?:runtime|out)(?:\/|$)/.test(rel)))return false;
  return true;
 }});
}
function copyFile(source,dest){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL);}
function checkedPayloadRelative(rel){if(typeof rel!=='string'||!rel||rel.includes('\\')||rel.includes(':')||rel.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Invalid frozen payload path');return rel;}

/** Copies frozen public bytes; only the host package metadata and fixed entry are overlaid. */
export function createPreviewLayout({stage,prepackaged,manifest,manifestSha256,sourceCommit,version,scanSummarySha256}){
 if(fs.existsSync(path.join(prepackaged,'resources','app')))throw Error('Preview application directory already exists');
 const resources=path.join(prepackaged,'resources'),appRoot=path.join(resources,'app');
 copyTree(stage,appRoot,{host:true,base:stage});
 for(const name of ['apps','vendor','workbench-gateway'])copyTree(path.join(stage,name),path.join(resources,name));
 copyFile(path.join(stage,'agent-beta-resources.json'),path.join(resources,'agent-beta-resources.json'));
 copyFile(path.join(stage,'desktop/agent-runtime/hermes-bootstrap.py'),path.join(resources,'agent-engines/hermes-bootstrap.py'));
 for(const [rel,expected]of Object.entries(manifest.payloadHashes)){
  checkedPayloadRelative(rel);
  const external=/^(?:apps|vendor|workbench-gateway)\//.test(rel),target=path.join(external?resources:appRoot,...rel.split('/'));
  if(digest(target)!==expected)throw Error('Frozen preview payload differs: '+rel);
  if(rel.startsWith('apps/')&&!/^apps\/[^/]+\/(?:runtime|out)(?:\/|$)/.test(rel)&&digest(path.join(appRoot,...rel.split('/')))!==expected)throw Error('Host adapter/public resource differs: '+rel);
 }
 if(digest(path.join(resources,'agent-beta-resources.json'))!==manifestSha256||json(path.join(appRoot,'desktop/agent-host/packaged-manifest.json')).sha256!==manifestSha256)throw Error('Copied preview manifest/pin mismatch');
 const pkgFile=path.join(appRoot,'package.json'),lockFile=path.join(appRoot,'package-lock.json'),pkg=json(pkgFile),lock=json(lockFile);
 const originalPackageSha256=digest(pkgFile),originalLockSha256=digest(lockFile);
 pkg.name='wucheng-agent-preview';pkg.productName='五成工作台 开发预览';pkg.main='preview-entry.mjs';
 lock.name=pkg.name;if(!lock.packages?.[''])throw Error('Frozen package lock root missing');lock.packages[''].name=pkg.name;
 fs.writeFileSync(pkgFile,JSON.stringify(pkg,null,2));fs.writeFileSync(lockFile,JSON.stringify(lock,null,2));
 const entryFile=path.join(appRoot,'preview-entry.mjs');if(fs.existsSync(entryFile))throw Error('Unexpected preview entry already in frozen stage');fs.writeFileSync(entryFile,previewEntry,{flag:'wx'});
 const html=fs.readFileSync(path.join(appRoot,'desktop/launcher/agent-index.html'),'utf8');
 if(!/class=["'][^"']*\bdevelopment-preview\b/.test(html))throw Error('Persistent development preview banner missing');
 const metadata={format:'agent-preview-package/v1',preview:true,verifiedFullBeta:false,version,sourceCommit,builderSourceSha256:digest(import.meta.filename),stageManifestSha256:manifestSha256,strictScanSummarySha256:scanSummarySha256,appId:'com.wucheng.ecommerce.erp.v2.agentpreview',profileRootName:'WuchengAgentBeta-preview',overlays:{package:{before:originalPackageSha256,after:digest(pkgFile)},packageLock:{before:originalLockSha256,after:digest(lockFile)},entry:{path:'preview-entry.mjs',sha256:digest(entryFile)}}};
 fs.writeFileSync(path.join(resources,'agent-preview-package.json'),JSON.stringify(metadata,null,2),{flag:'wx'});
 return {appRoot,metadata};
}

export async function buildPreview(inputs){
 const validated=await validateInputs(inputs);
 const outputBase=path.join(root,'.codex-artifacts/agent-preview-builds');fs.mkdirSync(outputBase,{recursive:true});
 const output=fs.mkdtempSync(path.join(outputBase,`preview-${validated.version}-${validated.sourceCommit.slice(0,12)}-`)),prepackaged=path.join(output,'prepackaged');
 copyTree(validated.electronDist,prepackaged);fs.renameSync(path.join(prepackaged,'electron.exe'),path.join(prepackaged,'WuchengAgentPreview.exe'));
 const {appRoot,metadata}=createPreviewLayout({...validated,prepackaged});
 // Recheck the original stage and current source after copying, before any NSIS invocation.
 const {auditStage}=await import('./agent-beta-package-audit.mjs');auditStage(validated.stage);
 const {suiteSourceDigests,suiteSourceDigest}=await import('./suite-source-digests.mjs');const {globalSourceHash}=await import('./agent-beta-coverage.mjs');
 if(gitCommit()!==validated.sourceCommit||!same(validated.sourceDigests,{business:suiteSourceDigests(root),desktop:suiteSourceDigest(path.join(root,'desktop')),global:globalSourceHash()}))throw Error('Source changed during preview preparation');
 if(digest(validated.scanSummary)!==validated.scanSummarySha256)throw Error('Strict public scan evidence changed during preview preparation');
 const configFile=path.join(output,'preview-builder.cjs'),artifactName=`WuchengAgentPreview-Setup-\${version}-preview-${validated.sourceCommit.slice(0,12)}-\${arch}.\${ext}`;
 const config={appId:metadata.appId,productName:'五成工作台 开发预览',executableName:'WuchengAgentPreview',artifactName,electronVersion:validated.electronVersion,directories:{output:path.join(output,'output')},publish:null,npmRebuild:false,win:{target:[{target:'nsis',arch:['x64']}]},nsis:{oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:false,deleteAppDataOnUninstall:false}};
 fs.writeFileSync(configFile,'module.exports='+JSON.stringify(config),{flag:'wx'});
 fs.writeFileSync(path.join(output,'validated-inputs.json'),JSON.stringify({stage:validated.stage,sourceCommit:validated.sourceCommit,sourceDigests:validated.sourceDigests,stageManifestSha256:validated.manifestSha256,scanSummary:validated.scanSummary,scanSummarySha256:validated.scanSummarySha256,scannerSha256,rulesSha256,scanConfigSha256,classificationPolicySha256,audit:validated.audit,metadata},null,2),{flag:'wx'});
 const builder=path.join(root,'node_modules/electron-builder/cli.js'),logFile=path.join(output,'builder.log'),log=fs.openSync(logFile,'wx');let result;
 try{result=spawnSync(process.execPath,[builder,'--projectDir',appRoot,'--prepackaged',prepackaged,'--config',configFile,'--win','--publish','never'],{cwd:root,stdio:['ignore',log,log],windowsHide:true});}finally{fs.closeSync(log);}
 fs.writeFileSync(path.join(output,'builder-result.json'),JSON.stringify({exitCode:result.status,signal:result.signal,spawnErrorCode:result.error?.code||null},null,2));
 if(result.status!==0)throw Error('Preview installer build failed; private builder log: '+logFile);
 const file=path.join(output,'output',`WuchengAgentPreview-Setup-${validated.version}-preview-${validated.sourceCommit.slice(0,12)}-x64.exe`);
 const summary={file,version:validated.version,sha256:digest(file),sourceCommit:validated.sourceCommit,stageManifestSha256:validated.manifestSha256,preview:true,verifiedFullBeta:false,installed:false,published:false,outputDirectory:output};
 fs.writeFileSync(path.join(output,'preview-result.json'),JSON.stringify(summary,null,2),{flag:'wx'});return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 if(process.argv.length!==5)throw Error('Usage: node scripts/build-agent-preview.mjs <prepared-stage-absolute-path> <locked-electron-dist-absolute-path> <strict-scan-summary-absolute-path>');
 console.log(JSON.stringify(await buildPreview({stage:process.argv[2],electronDist:process.argv[3],scanSummary:process.argv[4]})));
}
