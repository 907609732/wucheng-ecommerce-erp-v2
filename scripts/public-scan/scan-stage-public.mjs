// One-shot acceptance evidence harness. It never changes the stage or writes builder approval.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const evidenceRoot=import.meta.dirname,root=path.resolve(evidenceRoot,'../..');
const require=createRequire(path.join(root,'package.json'));
const asar=require('@electron/asar'),yauzl=require('yauzl');
const {auditStage}=await import(pathToFileURL(path.join(root,'scripts/agent-beta-package-audit.mjs')));
const {verifyVendor}=await import(pathToFileURL(path.join(root,'scripts/agent-beta-vendor.mjs')));
const {suiteSourceDigests,suiteSourceDigest}=await import(pathToFileURL(path.join(root,'scripts/suite-source-digests.mjs')));
const {globalSourceHash}=await import(pathToFileURL(path.join(root,'scripts/agent-beta-coverage.mjs')));
const {classifySecretFinding,classifyPublicRuntimePath,classificationPolicySha256}=await import(pathToFileURL(path.join(root,'scripts/agent-beta-scan-classification.mjs')));
const sha=b=>createHash('sha256').update(b).digest('hex');
const slash=s=>s.replaceAll('\\','/');
const inRoot=(base,file)=>{const r=path.relative(base,file);return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
if(!process.argv[2])throw Error('Usage: node scan-stage-public.mjs <prepared-stage-absolute-path>');
const input=path.resolve(process.argv[2]),stageBase=path.resolve(root,'dist/agent-beta/stages');
if(!path.isAbsolute(process.argv[2])||!inRoot(stageBase,input))throw Error('An actual isolated stage is required');
let ancestor=stageBase;
if(fs.lstatSync(stageBase).isSymbolicLink())throw Error('Linked stage root');
for(const part of path.relative(stageBase,input).split(path.sep)){ancestor=path.join(ancestor,part);if(fs.lstatSync(ancestor).isSymbolicLink())throw Error('Linked stage input');}
const stage=fs.realpathSync(input);
if(!inRoot(stageBase,stage))throw Error('Stage resolves outside staging root');
const out=fs.mkdtempSync(path.join(evidenceRoot,'stage-public-scan-'));
const extracted=path.join(out,'extracted');fs.mkdirSync(extracted);
const violations=[],review=[],classified=[],legacy=[],inventory=[],archives=[],asarInventory=[];
const counts={stageFiles:0,stageBytes:0,stageDirectories:0,firstPartyFiles:0,dependencyFiles:0,nativeRuntimeFiles:0,vendorFiles:0,asarFiles:0,asarEntries:0,asarFilesExtracted:0,asarIntegrityChecked:0,vendorZipEntries:0,vendorTextExtracted:0,textFilesScanned:0,textBytesScanned:0,sqliteMagicStageFilesChecked:0,sqliteMagicAsarFilesChecked:0,sqliteMagicVendorEntriesChecked:0,vendorZipHeaderOnlyEntries:0,vendorZipHeaderBytesRead:0};
const textExt=/\.(?:[cm]?js|jsx|tsx?|vue|jsonl?|map|html?|css|md|txt|ini|conf|config|ya?ml|toml|svg|py|ps1|bat|cmd|xml|sql|crt|pem|key)$/i;
const privateSegment=/^(?:data|originals?|attachments?|credentials|Partitions|Network|profile|backups?)$/i;
const privateBase=/^(?:\.env(?:\..*)?|secrets\.bin|Cookies(?:-journal)?|Login Data(?:-journal)?|Web Data(?:-journal)?|credentials\.json|auth\.json|tokens?\.json)$/i;
const privateExt=/\.(?:sqlite(?:-wal|-shm)?|sqlite3|db|pfx|p12|pem|key)$/i;
const knownCodeData=[
 /(?:^|\/)node_modules\/echarts\/(?:lib\/data|types\/src\/data)(?:\/|$)/,
 /(?:^|\/)node_modules\/moment-timezone\/data(?:\/(?:packed|meta)(?:\/latest\.json)?)?$/,
 /(?:^|\/)node_modules\/node-gyp\/gyp\/data(?:\/(?:win|ninja)(?:\/|$))?/,
 /(?:^|\/)node_modules\/resedit\/dist\/(?:_esm\/)?(?:sign\/)?data(?:\/|$)/,
 /(?:^|\/)node_modules\/@alicloud\/credentials(?:\/|$)/
];
const fixtureKeys=new Map([
 ['@fastify/reply-from/test/fixtures/fastify.key','6253917211cc9b8cf7768312318d9cac2688e36347f73024b648c750aa02a5e9'],
 ['@fastify/reply-from/test/fixtures/localhost.key','f236ddc49480e7cacc74423759e9d82397a7747aa3d967f1edc90377ffbb2316']
]);
const officialConfigFile=path.join(evidenceRoot,'gitleaks-v8.30.1.official.toml');
const officialConfigExpectedSha256='e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf';
let strictConfigSha256=null,scannerVersion=null;
const findings=(array,rule,file,extra={})=>array.push({rule,path:slash(file),...extra});
function category(rel){if(rel.startsWith('vendor/'))return 'vendor';if(rel.includes('/node_modules/')||rel.startsWith('node_modules/'))return 'dependency';if(/^apps\/(?:warehouse|exporter)\/runtime\//.test(rel))return 'native-runtime';return 'first-party';}
function checkPrivate(rel,kind,digest,isDirectory=false,physicalFile){
 const parts=rel.split('/'),base=parts.at(-1),hit=parts.some(x=>privateSegment.test(x))||privateBase.test(base)||privateExt.test(base);
 if(!hit)return;
 const approved=kind==='dependency'&&physicalFile?classifyPublicRuntimePath(physicalFile,{isDirectory}):null;
 if(approved){if(!isDirectory)findings(classified,'pinned-public-runtime-resource',rel,{sha256:digest,...approved});return;}
 const safeData=knownCodeData.find(re=>re.test(rel));
 if(kind==='dependency'&&safeData&&!privateBase.test(base)&&!privateExt.test(base)){
  if(!isDirectory)findings(classified,'upstream-code-or-public-data',rel,{sha256:digest});return;
 }
 const marker=rel.lastIndexOf('node_modules/'),sub=marker>=0?rel.slice(marker+'node_modules/'.length):'';
 if(kind==='dependency'&&fixtureKeys.has(sub)&&fixtureKeys.get(sub)===digest){findings(review,'known-upstream-test-private-key-needs-explicit-review',rel,{sha256:digest});return;}
 findings(violations,isDirectory?'private-payload-directory':'private-payload-path',rel,{category:kind,sha256:digest});
}
const currentPersonal=/\bC:(?:\\+|\/)Users(?:\\+|\/)90760(?:\\+|\/|["'\s]|$)|\bE:(?:\\+|\/)~1awucheng(?:\\+|\/|["'\s]|$)/gi;
const formalAbsolute=/\b[A-Za-z]:(?:\\+|\/)[^\r\n"'<>]{0,220}(?:LingtuWorkbench|Plastic SCM)(?:\\+|\/|["'\s]|$)/gi;
const hooks=[
 ['dingtalk-private-webhook',/https?:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9_-]{16,}/gi],
 ['wecom-private-webhook',/https?:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]{16,}/gi],
 ['slack-private-webhook',/https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{16,}/gi],
 ['feishu-private-webhook',/https?:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{20,}/gi],
 ['openai-style-secret-token',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g]
];
function scanText(buffer,rel){
 if(buffer.length===0)return;
 const sample=buffer.subarray(0,8192);if(sample.includes(0))return;
 const ext=textExt.test(rel),name=path.basename(rel);if(!ext&&!/^(?:LICENSE|NOTICE|COPYING|README)(?:\.|$)/i.test(name)&&sample.some(x=>x<9||x>13&&x<32))return;
 const text=buffer.toString('utf8');counts.textFilesScanned++;counts.textBytesScanned+=buffer.length;
 const rules=[['current-personal-absolute-path',currentPersonal],['formal-data-absolute-path',formalAbsolute],...hooks];
 for(const [rule,re] of rules){re.lastIndex=0;for(const m of text.matchAll(re)){const line=text.slice(0,m.index).split('\n').length;findings(violations,rule,rel,{line,matchSha256:sha(m[0])});}}
 const old=/(?:LingtuWorkbench|127\.0\.0\.1:17\d{3}|localhost:17\d{3}|WuchengAgentBeta-preview|WuchengAgentPreview)/g;
 for(const m of text.matchAll(old)){findings(legacy,'legacy-default-or-port-literal',rel,{line:text.slice(0,m.index).split('\n').length,matchSha256:sha(m[0])});}
}
function checkSqliteMagic(buffer,rel,scope,digest){
 const counter={stage:'sqliteMagicStageFilesChecked',asar:'sqliteMagicAsarFilesChecked',vendor:'sqliteMagicVendorEntriesChecked'}[scope];
 if(!counter)throw Error('Unknown SQLite header scan scope');counts[counter]++;
 const header=buffer.subarray(0,16);
 if(header.toString('latin1')==='SQLite format 3\0')findings(violations,'sqlite-database-magic',rel,{...(digest?{sha256:digest}:{}),headerSha256:sha(header),checkedHeaderBytes:header.length});
}
async function readVendorZipHeader(zip,entry){
 const wanted=Math.min(16,entry.uncompressedSize);if(wanted===0)return Buffer.alloc(0);
 const stream=await new Promise((resolve,reject)=>zip.openReadStream(entry,(error,value)=>error?reject(error):resolve(value)));
 return await new Promise((resolve,reject)=>{
  let settled=false;
  stream.on('error',error=>{if(!settled){settled=true;reject(error);}});
  stream.on('readable',()=>{
   if(settled)return;const header=stream.read(wanted);if(header===null)return;
   settled=true;stream.destroy();resolve(header);
  });
  stream.on('end',()=>{if(!settled){settled=true;reject(Error('Vendor ZIP entry ended before its declared header'));}});
  stream.on('close',()=>{if(!settled){settled=true;reject(Error('Vendor ZIP header stream closed prematurely'));}});
 });
}
function safeEntry(rel){
 if(typeof rel!=='string'||!rel||/[:\x00-\x1f]/.test(rel)||rel.includes('\\')||rel.startsWith('/')||rel.split('/').some(x=>x==='..'||x==='.'||x===''))throw Error('Unsafe archive entry path');
 return rel;
}
function walk(dir){
 counts.stageDirectories++;
 for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const file=path.join(dir,e.name),rel=slash(path.relative(stage,file));
  if(e.isSymbolicLink()||fs.lstatSync(file).isSymbolicLink()){findings(violations,'filesystem-link',rel);continue;}
  if(e.isDirectory()){checkPrivate(rel,category(rel),undefined,true,file);walk(file);continue;}
  if(!e.isFile()){findings(violations,'nonregular-payload-entry',rel);continue;}
  const buffer=fs.readFileSync(file),digest=sha(buffer),kind=category(rel);counts.stageFiles++;counts.stageBytes+=buffer.length;
  if(kind==='dependency')counts.dependencyFiles++;else if(kind==='native-runtime')counts.nativeRuntimeFiles++;else if(kind==='vendor')counts.vendorFiles++;else counts.firstPartyFiles++;
  inventory.push({path:rel,category:kind,bytes:buffer.length,sha256:digest});checkPrivate(rel,kind,digest,false,file);scanText(buffer,rel);
  checkSqliteMagic(buffer,rel,'stage',digest);
  if(/\.asar$/i.test(rel))archives.push({file,rel,sha256:digest});
 }
}
function extractAsar(item,index){
 counts.asarFiles++;const pendingPrivate=[];const report={path:item.rel,sha256:item.sha256,entries:0,files:0,integrityChecked:0};
 for(const entry of asar.listPackage(item.file)){
  const rel=safeEntry(slash(entry).replace(/^\//,'')),metadata=asar.statFile(item.file,path.normalize(rel),false);report.entries++;counts.asarEntries++;
  if(metadata.link){findings(violations,'asar-link',item.rel+'!/'+rel);continue;}
  if(metadata.files)continue;
  const buffer=asar.extractFile(item.file,path.normalize(rel)),digest=sha(buffer),display=item.rel+'!/'+rel;
  asarInventory.push({path:display,bytes:buffer.length,sha256:digest,integrityPresent:!!metadata.integrity});
  if(metadata.integrity){if(metadata.integrity.algorithm!=='SHA256'||metadata.integrity.hash!==digest)findings(violations,'asar-internal-integrity-mismatch',display,{sha256:digest});else{report.integrityChecked++;counts.asarIntegrityChecked++;}}
  const target=path.resolve(extracted,'asar-'+index,rel);if(!inRoot(path.join(extracted,'asar-'+index),target))throw Error('ASAR extraction escapes private output');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,buffer);report.files++;counts.asarFilesExtracted++;
  pendingPrivate.push({display,kind:category(rel),digest,target});scanText(buffer,display);checkSqliteMagic(buffer,display,'asar',digest);
 }
 for(const item of pendingPrivate)checkPrivate(item.display,item.kind,item.digest,false,item.target);
 return report;
}
async function listVendorZip(component,index){
 const zipFile=path.join(stage,'vendor',component.archive),zip=await new Promise((resolve,reject)=>yauzl.open(zipFile,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,value)=>error?reject(error):resolve(value)));
 const entries=[],names=new Set(),report={path:'vendor/'+component.archive,sha256:component.sha256,entries:0,textFilesExtracted:0,sqliteMagicEntriesChecked:0,headerOnlyEntriesChecked:0,headerBytesRead:0};
 await new Promise((resolve,reject)=>{
  zip.on('error',reject);zip.on('end',resolve);
  zip.on('entry',entry=>{(async()=>{
   const directory=entry.fileName.endsWith('/'),rel=safeEntry(directory?entry.fileName.slice(0,-1):entry.fileName),mode=(entry.externalFileAttributes>>>16)&0o170000;
   report.entries++;counts.vendorZipEntries++;entries.push({path:rel,bytes:entry.uncompressedSize,directory});
   if(names.has(rel.toLowerCase()))findings(violations,'vendor-zip-duplicate-windows-path',report.path+'!/'+rel);names.add(rel.toLowerCase());
   if(mode===0o120000){findings(violations,'vendor-zip-link',report.path+'!/'+rel);zip.readEntry();return;}
   if(mode!==0&&mode!==0o100000&&mode!==0o040000){findings(violations,'vendor-zip-nonregular-entry',report.path+'!/'+rel);zip.readEntry();return;}
   if(entry.generalPurposeBitFlag&1){findings(violations,'vendor-zip-encrypted-entry',report.path+'!/'+rel);zip.readEntry();return;}
   checkPrivate(report.path+'!/'+rel,'vendor-signed-upstream',undefined,directory);
   if(!directory&&textExt.test(rel)&&entry.uncompressedSize<=20*1024**2){
    const stream=await new Promise((ok,no)=>zip.openReadStream(entry,(e,s)=>e?no(e):ok(s))),chunks=[];
    for await(const chunk of stream)chunks.push(chunk);const buffer=Buffer.concat(chunks),target=path.resolve(extracted,'vendor-'+index,rel);
    if(!inRoot(path.join(extracted,'vendor-'+index),target))throw Error('ZIP extraction escapes private output');
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,buffer);scanText(buffer,report.path+'!/'+rel);checkSqliteMagic(buffer,report.path+'!/'+rel,'vendor',sha(buffer));report.sqliteMagicEntriesChecked++;report.textFilesExtracted++;counts.vendorTextExtracted++;
   }else if(!directory){
    // Signed binary members need only a bounded SQLite header probe; no full extraction.
    const header=await readVendorZipHeader(zip,entry);checkSqliteMagic(header,report.path+'!/'+rel,'vendor');report.sqliteMagicEntriesChecked++;report.headerOnlyEntriesChecked++;report.headerBytesRead+=header.length;counts.vendorZipHeaderOnlyEntries++;counts.vendorZipHeaderBytesRead+=header.length;
   }
   zip.readEntry();
  })().catch(error=>{zip.close();reject(error);});});zip.readEntry();
 });
 fs.writeFileSync(path.join(out,'vendor-'+index+'-entries.json'),JSON.stringify(entries,null,2));return report;
}
let manifest,manifestHash,audit,vendor,sourceNow,commit,scanStatus=null,scanSignal=null,error=null,unresolvedSecretFindings=0,classifiedFalsePositiveFindings=0,secretScansComplete=false;
try{
 manifest=JSON.parse(fs.readFileSync(path.join(stage,'agent-beta-resources.json'),'utf8'));manifestHash=sha(fs.readFileSync(path.join(stage,'agent-beta-resources.json')));
 commit=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout.trim();
 sourceNow={business:suiteSourceDigests(root),desktop:suiteSourceDigest(path.join(root,'desktop')),global:globalSourceHash()};
 if(JSON.stringify(sourceNow)!==JSON.stringify(manifest.sourceDigests))throw Error('Source changed since staging; stop this acceptance');
 audit=auditStage(stage);vendor=verifyVendor(path.join(stage,'vendor'),JSON.parse(fs.readFileSync(path.join(stage,'desktop/launcher/public-keys.json'))));
 walk(stage);
 const traversedHashes=new Map(inventory.map(x=>[x.path,x.sha256]));
 for(const [file,digest] of Object.entries(manifest.payloadHashes))if(traversedHashes.get(file)!==digest)findings(violations,'payload-changed-during-scan',file);
 const asarReports=archives.map((item,index)=>extractAsar(item,index));
 for(const module of ['warehouse','exporter'])if(!archives.some(x=>x.rel==='apps/'+module+'/runtime/resources/app.asar'))findings(violations,'required-component-asar-missing','apps/'+module+'/runtime/resources/app.asar');
 const vendorReports=[];for(let index=0;index<vendor.components.length;index++)vendorReports.push(await listVendorZip(vendor.components[index],index));
 fs.writeFileSync(path.join(out,'archive-summary.json'),JSON.stringify({asar:asarReports,vendor:vendorReports},null,2));
 const config=path.join(out,'gitleaks.toml'),officialConfig=fs.readFileSync(officialConfigFile,'utf8');
 if(sha(fs.readFileSync(officialConfigFile))!==officialConfigExpectedSha256)throw Error('Fixed official gitleaks rule configuration hash mismatch');
 const firstRule=officialConfig.indexOf('[[rules]]');if(firstRule<0)throw Error('Official gitleaks configuration has no rules');
 const head=officialConfig.slice(0,firstRule),tail=officialConfig.slice(firstRule);
 const strictPaths='paths = [\n    \'(?i)\\.(?:bmp|gif|jpe?g|png|tiff?|eot|otf|ttf|woff2?|dll|pdb|exe|node|pak|zip|asar|wasm|icns|ico|mp[34]|wav|ogg|webm)$\',\n    \'(^|[\\\\/])reading_mode_gdocs_helper_manifest\\.json$\',\n]';
 if(!/^paths = \[[\s\S]*?^\]/m.test(head))throw Error('Official gitleaks global path list unavailable');
 const strictConfig=head.replace(/^paths = \[[\s\S]*?^\]/m,()=>strictPaths)+tail;
 // Explicitly remove inherited blanket text exclusions, including node_modules and lock files.
 if(strictConfig.slice(0,strictConfig.indexOf('[[rules]]')).includes('node_modules'))throw Error('Dependency exclusion survived strict configuration');
 fs.writeFileSync(config,strictConfig);strictConfigSha256=sha(strictConfig);
 const ignoreFile=path.join(out,'empty.gitleaksignore');fs.writeFileSync(ignoreFile,'');
 const versionResult=spawnSync('gitleaks',['version'],{encoding:'utf8',windowsHide:true});scannerVersion=(versionResult.stdout||'').trim();
 if(versionResult.status!==0||scannerVersion!=='8.30.1')throw Error('Scanner version differs from fixed official rules');
 const scans=[];
 for(const [name,target] of [['actual-stage',stage],['extracted-archive-files',extracted]]){
  const report=path.join(out,'gitleaks-'+name+'.redacted.json');
  const result=spawnSync('gitleaks',['dir',target,'--config',config,'--gitleaks-ignore-path',ignoreFile,'--redact=100','--ignore-gitleaks-allow','--no-banner','--log-level','error','--report-format','json','--report-path',report],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024**2});
  const findingsList=fs.existsSync(report)?(JSON.parse(fs.readFileSync(report,'utf8'))||[]):[];
  const minimal=findingsList.map(x=>({rule:x.RuleID,path:slash(path.relative(target,x.File)),line:x.StartLine,endLine:x.EndLine,fingerprintSha256:sha(String(x.Fingerprint||''))}));
  fs.writeFileSync(path.join(out,'gitleaks-'+name+'.findings.json'),JSON.stringify(minimal,null,2));
  const reviewed=findingsList.map((finding,index)=>{const file=path.isAbsolute(finding.File)?path.resolve(finding.File):path.resolve(target,finding.File);if(!inRoot(target,file))throw Error('Secret scanner finding path escapes its input');return {index,fingerprintSha256:sha(String(finding.Fingerprint||'')),classification:classifySecretFinding({finding,file,stage,verifiedPayloadHashes:traversedHashes})};});
  const unknown=reviewed.filter(x=>!x.classification).length,accepted=reviewed.length-unknown;unresolvedSecretFindings+=unknown;classifiedFalsePositiveFindings+=accepted;
  fs.writeFileSync(path.join(out,'gitleaks-'+name+'.classified.json'),JSON.stringify(reviewed,null,2));
  scans.push({name,exitCode:result.status,signal:result.signal,findings:minimal.length,classifiedFalsePositives:accepted,unresolvedFindings:unknown,report:path.basename(report),stderrSha256:sha(result.stderr||''),spawnErrorCode:result.error?.code||null});
  if(result.error||result.signal||!((result.status===0&&minimal.length===0)||(result.status===1&&minimal.length>0)))findings(violations,'gitleaks-execution-incomplete',name,{exitCode:result.status,findings:minimal.length,spawnErrorCode:result.error?.code||null});
  if(unknown)findings(violations,'gitleaks-unresolved-findings',name,{rawExitCode:result.status,rawFindings:minimal.length,unresolvedFindings:unknown});
 }
 secretScansComplete=scans.length===2&&scans.every(x=>!x.signal&&!x.spawnErrorCode&&(x.exitCode===0&&x.findings===0||x.exitCode===1&&x.findings>0));scanStatus=scans.every(x=>x.exitCode===0)?0:1;scanSignal=scans.map(x=>x.signal).filter(Boolean);fs.writeFileSync(path.join(out,'gitleaks-scanners.json'),JSON.stringify(scans,null,2));
 const sourceAfter={business:suiteSourceDigests(root),desktop:suiteSourceDigest(path.join(root,'desktop')),global:globalSourceHash()};
 if(JSON.stringify(sourceNow)!==JSON.stringify(sourceAfter))findings(violations,'source-changed-during-scan','source');
 if(manifestHash!==sha(fs.readFileSync(path.join(stage,'agent-beta-resources.json'))))findings(violations,'manifest-changed-during-scan','agent-beta-resources.json');
}catch(e){error={name:e.name,message:String(e.message).slice(0,500)};findings(violations,'scan-execution-error','scanner',{errorName:e.name});}
const inventoryBytes=JSON.stringify(inventory,null,2);fs.writeFileSync(path.join(out,'payload-inventory.json'),inventoryBytes);const payloadInventorySha256=sha(inventoryBytes);
fs.writeFileSync(path.join(out,'asar-inventory.json'),JSON.stringify(asarInventory,null,2));
for(const [name,entries] of [['violations',violations],['needs-review',review],['classified-upstream-files',classified],['legacy-literals',legacy]])fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(entries,null,2));
const summary={ok:!error&&violations.length===0&&review.length===0&&secretScansComplete&&unresolvedSecretFindings===0,scope:'isolated-beta',execution:'stage-public-scan',stage,stageManifestSha256:manifestHash||null,sourceCommit:commit||null,sourceDigests:manifest?.sourceDigests||null,currentSourceDigests:sourceNow||null,vendor:vendor||null,audit:audit||null,counts,violations:violations.length,needsReview:review.length,classifiedUpstreamFiles:classified.length,legacyLiteralOccurrences:legacy.length,scannerVersion,officialRuleSource:'https://raw.githubusercontent.com/gitleaks/gitleaks/v8.30.1/config/gitleaks.toml',officialRuleSha256:officialConfigExpectedSha256,strictConfigSha256,scannerExitCode:scanStatus,scannerSignal:scanSignal,classificationPolicySha256,payloadInventorySha256,unresolvedSecretFindings,classifiedFalsePositiveFindings,secretScansComplete,error,evidenceDirectory:out,limitations:['Static payload scan and literal dependency resolution only; no dynamic runtime isolation or real AI/platform claim.','Legacy default algorithms and port literals are reported separately; actual configured personal/formal absolute paths remain blocking.','Raw scanner exit codes and findings remain unchanged. Finite reviewed public syntax/digest classifications are recorded separately; unknown findings and private-key/JWT material remain blocking.','Signed vendor archives and native binary assets are inventoried and hashed; their non-binary archive entries are additionally scanned.'],builderEvidenceWritten:false};
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));process.exitCode=summary.ok?0:1;
