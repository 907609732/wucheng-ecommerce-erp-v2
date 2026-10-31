import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertPublicScanBinding,createPreviewLayout,previewEntry} from '../scripts/build-agent-preview.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceDigests={business:{purchase:'p',sales:'s',overview:'o',exporter:'e',warehouse:'w'},desktop:'d',global:'g'};
const binding={stage:'C:\\isolated-stage',manifestSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40),sourceDigests};
function proof(){return {ok:true,scope:'isolated-beta',execution:'stage-public-scan',error:null,scannerExitCode:0,scannerVersion:'8.30.1',violations:0,needsReview:0,audit:{ok:true},stage:binding.stage,stageManifestSha256:binding.manifestSha256,sourceCommit:binding.sourceCommit,sourceDigests:structuredClone(sourceDigests),currentSourceDigests:structuredClone(sourceDigests),officialRuleSha256:'e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf',strictConfigSha256:'ebf46a58b5d6ed45d3260602db2713f31732ec466607dc8483473504ce09e45e',counts:{stageFiles:10,sqliteMagicStageFilesChecked:10,asarFiles:2,asarFilesExtracted:4,sqliteMagicAsarFilesChecked:4,asarIntegrityChecked:4,vendorZipEntries:2,sqliteMagicVendorEntriesChecked:2,vendorTextExtracted:1}};}
test('preview requires a successful strict scan bound to the exact source and stage',()=>{
 assert.doesNotThrow(()=>assertPublicScanBinding(proof(),binding));
 for(const key of ['stage','stageManifestSha256','sourceCommit','sourceDigests','currentSourceDigests']){const changed=proof();changed[key]=key.endsWith('Digests')?{stale:true}:'stale';assert.throws(()=>assertPublicScanBinding(changed,binding),/stale|bound/);}
});
test('failed scans, unresolved fixture keys and missing archive magic coverage block preview packaging',()=>{
 for(const update of [{ok:false},{scannerExitCode:1},{violations:1},{needsReview:1},{error:{name:'Error'}}])assert.throws(()=>assertPublicScanBinding({...proof(),...update},binding),/failed|incomplete/);
 const incomplete=proof();incomplete.counts.sqliteMagicAsarFilesChecked=0;assert.throws(()=>assertPublicScanBinding(incomplete,binding),/coverage/);
});
function fixture(t){
 const base=path.resolve('.codex-artifacts/agent-preview-build-tests');fs.mkdirSync(base,{recursive:true});const work=fs.mkdtempSync(path.join(base,'layout-'));t.after(()=>{const resolved=fs.realpathSync(work),relative=path.relative(base,resolved);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Fixture cleanup target escaped its private directory');fs.rmSync(resolved,{recursive:true,force:true});});const stage=path.join(work,'stage'),prepackaged=path.join(work,'prepackaged');fs.mkdirSync(stage);fs.mkdirSync(prepackaged);
 const files={'package.json':JSON.stringify({name:'wucheng-agent-beta',version:'0.11.6',main:'desktop/launcher/main.mjs'}),'package-lock.json':JSON.stringify({name:'wucheng-agent-beta',packages:{'':{name:'wucheng-agent-beta'}}}),'desktop/launcher/agent-index.html':'<body><aside class="development-preview">开发预览</aside></body>','desktop/agent-runtime/hermes-bootstrap.py':'# public bootstrap','node_modules/example/index.js':'export const production=true','workbench-gateway/desktop/agent-runtime/mcp-entry.mjs':'// public gateway','vendor/catalog.json':'{}','vendor/runtime.zip':'signed fixture bytes'};
 for(const id of ['purchase','sales','overview']){files[`apps/${id}/server.mjs`]='// real service entry';files[`apps/${id}/public/index.html`]=`${id} current public page`;files[`apps/${id}/node_modules/example/index.js`]='// production dependency';}
 files['apps/warehouse/runtime/WuchengAgentBetaWarehouse.exe']='warehouse binary fixture';files['apps/warehouse/runtime/resources/app.asar']='warehouse asar fixture';files['apps/exporter/runtime/WuchengAgentBetaExporter.exe']='exporter binary fixture';files['apps/exporter/runtime/resources/app.asar']='exporter asar fixture';files['apps/exporter/src/main/agent-adapter.mjs']='// exporter adapter';files['apps/exporter/out/main/preview-ledger.js']='import "./chunks/store.js"';files['apps/exporter/out/main/chunks/store.js']='// bundled production store';
 for(const [rel,bytes]of Object.entries(files)){const file=path.join(stage,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
 const manifest={format:'test-only-frozen-payload',payloadHashes:Object.fromEntries(Object.entries(files).map(([rel,bytes])=>[rel,hash(bytes)]))},serialized=JSON.stringify(manifest),manifestSha256=hash(serialized);fs.writeFileSync(path.join(stage,'agent-beta-resources.json'),serialized);const pin=path.join(stage,'desktop/agent-host/packaged-manifest.json');fs.mkdirSync(path.dirname(pin),{recursive:true});fs.writeFileSync(pin,JSON.stringify({sha256:manifestSha256}));
 return {stage,prepackaged,manifest,manifestSha256,sourceCommit:binding.sourceCommit,version:'0.11.6',scanSummarySha256:'c'.repeat(64)};
}
test('preview layout retains all business pages, production dependencies, actual runtimes and external engine resources',t=>{
 const input=fixture(t),before=fs.readFileSync(path.join(input.stage,'agent-beta-resources.json'));const {appRoot,metadata}=createPreviewLayout(input),resources=path.join(input.prepackaged,'resources');
 for(const id of ['purchase','sales','overview'])assert.equal(fs.readFileSync(path.join(resources,`apps/${id}/public/index.html`),'utf8'),`${id} current public page`);
 for(const rel of ['apps/purchase/node_modules/example/index.js','apps/warehouse/runtime/resources/app.asar','apps/exporter/runtime/resources/app.asar','apps/exporter/out/main/preview-ledger.js','apps/exporter/out/main/chunks/store.js','vendor/runtime.zip','workbench-gateway/desktop/agent-runtime/mcp-entry.mjs'])assert.ok(fs.existsSync(path.join(resources,rel)),rel);
 assert.equal(fs.readFileSync(path.join(appRoot,'preview-entry.mjs'),'utf8'),previewEntry);assert.doesNotMatch(previewEntry,/LOCALAPPDATA|LINGTU_AGENT_BETA_ROOT/);assert.match(previewEntry,/LINGTU_AGENT_PREVIEW='1'/);
 assert.deepEqual(fs.readFileSync(path.join(input.stage,'agent-beta-resources.json')),before);assert.equal(JSON.parse(fs.readFileSync(path.join(input.stage,'package.json'))).name,'wucheng-agent-beta');assert.equal(metadata.appId,'com.wucheng.ecommerce.erp.v2.agentpreview');assert.equal(metadata.verifiedFullBeta,false);
});
test('payload corruption is rejected instead of being repinned into a preview',t=>{
 const input=fixture(t);fs.writeFileSync(path.join(input.stage,'apps/sales/public/index.html'),'changed after scan');assert.throws(()=>createPreviewLayout(input),/Frozen preview payload differs/);
});
