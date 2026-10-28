// Build every business component from this one source tree. Only immutable,
// already-signed vendor runtimes may be reused; no historical business ZIP is used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createPrivateKey,sign} from 'node:crypto';
import {digest,verifyCatalog} from '../desktop/modules/package-format.mjs';
import {suiteSourceExcluded,suiteSourceDigests} from './suite-source-digests.mjs';
import {selectSuiteVendorRuntimes} from './lib/suite-vendor-cache.mjs';

const root=process.cwd(),host=JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8'));
const keys=JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8'));
const vendorCache=await selectSuiteVendorRuntimes({root,hostVersion:host.version,publicKeys:keys});
if(process.argv.includes('--verify-vendors')){
 console.log(JSON.stringify({ok:true,readOnly:true,source:vendorCache.source,directory:vendorCache.directory,runtimes:vendorCache.vendors.map(({spec})=>({id:spec.id,version:spec.version,bytes:spec.bytes,sha256:spec.sha256}))}));process.exit(0);
}
// Sync presentation assets before fingerprints or packaging, including exporter.
await import('./sync-loading-assets.mjs');
const output=fs.mkdtempSync(path.resolve('dist/suite-payload-'));
const work=fs.mkdtempSync(path.resolve('dist/suite-build-'));
const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const builder=path.join(root,'node_modules/electron-builder/cli.js');
const keyFile=process.env.LINGTU_MODULE_SIGNING_KEY||path.join(os.homedir(),'.codex','module-signing','lingtu-release-ed25519.pem');
if(path.resolve(keyFile).toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('Release signing key must remain outside the workspace');
const key=createPrivateKey(fs.readFileSync(keyFile));
if(key.asymmetricKeyType!=='ed25519')throw Error('Release signing requires Ed25519');
const keyId=process.env.LINGTU_MODULE_SIGNING_KEY_ID||'lingtu-2026';
function run(file,args,options={}){
 const r=spawnSync(file,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});if(r.status!==0)throw Error('Suite build step failed: '+path.basename(file)+' '+args[0]);
}
const excluded=suiteSourceExcluded;
function copy(source,target){fs.cpSync(source,target,{recursive:true,filter:file=>{if(fs.lstatSync(file).isSymbolicLink())throw Error('Suite source contains a link');return !excluded.test(path.relative(source,file).replaceAll('\\','/'));}});}
const sources=suiteSourceDigests(root);
// UI-only product updates may retain byte-identical signed components, but only
// when the complete first-party source fingerprint is unchanged. Changed code
// still goes through its normal production build and component version gate.
const reuseBase=process.argv.includes('--reuse-unchanged')?verifyCatalog(JSON.parse(fs.readFileSync(path.join(vendorCache.directory,'catalog.json'),'utf8')),keys,{hostVersion:host.version,platform:'win32',arch:'x64'}):null;
async function reuseUnchanged(id){
 if(!reuseBase||reuseBase.suite?.sourceFingerprintVersion!==2||reuseBase.suite.sourceDigests?.[id]!==sources[id])return false;
 const spec=reuseBase.packages.find(p=>p.id===id);if(!spec)throw Error('Missing signed component: '+id);reuseBase.compatible(spec);
 const file=path.join(vendorCache.directory,safeArchive(spec.archive));
 if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size!==spec.bytes||await digest(file)!==spec.sha256)throw Error('Unchanged component archive changed: '+id);
 fs.copyFileSync(file,path.join(output,spec.archive));
 if(await digest(path.join(output,spec.archive))!==spec.sha256)throw Error('Copied component digest mismatch: '+id);
 fs.writeFileSync(path.join(output,id+'.descriptor.json'),JSON.stringify(spec,null,2));
 console.log(JSON.stringify({id,reusedUnchangedSignedSource:true,version:spec.version}));return true;
}
function safeArchive(name){if(typeof name!=='string'||path.basename(name)!==name||!name.endsWith('.zip'))throw Error('Unsafe signed archive name');return name;}

// Signed, fixed Node and browser vendor runtime artifacts are content checked,
// never downloaded from a URL embedded by an untrusted local descriptor.
for(const {spec,file} of vendorCache.vendors){
 const copied=path.join(output,spec.archive);fs.copyFileSync(file,copied);
 if(fs.statSync(copied).size!==spec.bytes||await digest(copied)!==spec.sha256)throw Error('Copied vendor runtime changed during suite preparation: '+spec.id);
 fs.writeFileSync(path.join(output,spec.id+'.descriptor.json'),JSON.stringify(spec,null,2));
}
for(const id of ['purchase','sales','overview'])if(!await reuseUnchanged(id))run(process.execPath,['scripts/build-module-pack.mjs','--id',id,'--source',path.join(root,'apps',id),'--output',output,'--tag','v'+host.version]);

// Warehouse is still an isolated Electron worker. Its private working directory
// and executable name remain separate from the foreground workbench installer.
if(!await reuseUnchanged('warehouse')){
const cloudStage=path.join(work,'warehouse-source');fs.mkdirSync(cloudStage);
for(const name of ['desktop','core','config.json','package.json','package-lock.json'])copy(path.join(root,name),path.join(cloudStage,name));
run(process.execPath,[npmCli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:cloudStage});
const cloudOutput=path.join(work,'warehouse-output'),cloudConfig=path.join(work,'warehouse-builder.cjs');
const cloudBuildInfo=path.join(work,'cloud-build-info.json');fs.writeFileSync(cloudBuildInfo,JSON.stringify({channel:'release',productVersion:host.version,builtAt:new Date().toISOString(),sourceDigest:sources.warehouse}));
fs.writeFileSync(cloudConfig,'module.exports='+JSON.stringify({appId:'com.wucheng.ecommerce.erp.v2',productName:'菜鸟云仓同步',executableName:'LingtuWarehouseModule',electronVersion:JSON.parse(fs.readFileSync('node_modules/electron/package.json','utf8')).version,electronDist:path.join(root,'node_modules/electron/dist'),directories:{output:cloudOutput},files:['desktop/**/*','!desktop/launcher/**/*','!desktop/workbench-client/**/*','!desktop/workbench-migration/**/*','!desktop/invoice-module/**/*','!desktop/shared/cli-child-result.mjs','!desktop/workbench/{gateway,server,store,manifest,policy}.mjs','!desktop/modules/{module-manager,package-format,service-lifecycle,electron-lifecycle,bundled-suite}.mjs','core/**/*','config.json','package.json','!node_modules/**/{test,tests,__tests__,examples,benchmark,benchmarks}/**'],extraResources:[{from:cloudBuildInfo,to:'build-info.json'}],asar:true,npmRebuild:false,win:{icon:path.join(root,'desktop/assets/lingtu-icon.png'),target:[{target:'dir',arch:['x64']}]}}));
run(process.execPath,[builder,'--projectDir',cloudStage,'--config',cloudConfig,'--win','--dir','--publish','never']);
const cloudVersion=JSON.parse(fs.readFileSync(path.join(cloudStage,'package.json'),'utf8')).version;
run(process.execPath,['scripts/build-module-pack.mjs','--id','warehouse','--source',path.join(cloudOutput,'win-unpacked'),'--output',output,'--tag','v'+host.version,'--version',cloudVersion,'--entry','LingtuWarehouseModule.exe']);

}
if(!await reuseUnchanged('exporter')){
const exporterStage=path.join(work,'exporter-source');copy(path.join(root,'apps/exporter'),exporterStage);
run(process.execPath,[npmCli,'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:exporterStage});
// The Electron install script uses the version from the imported lockfile and
// official cached/downloaded vendor binary; it never runs a historical app build.
run(process.execPath,[path.join(exporterStage,'node_modules/electron/install.js')],{cwd:exporterStage});
run(process.execPath,[npmCli,'run','build'],{cwd:exporterStage});
const exporterOutput=path.join(work,'exporter-output'),exporterConfig=path.join(work,'exporter-builder.cjs');
fs.writeFileSync(exporterConfig,'module.exports='+JSON.stringify({appId:'com.lingtu.order-export',productName:'灵兔 AI 电商平台买家订单导出工具',executableName:'LingtuOrderExporter',electronVersion:JSON.parse(fs.readFileSync(path.join(exporterStage,'node_modules/electron/package.json'),'utf8')).version,electronDist:path.join(exporterStage,'node_modules/electron/dist'),directories:{output:exporterOutput},files:['out/**','build/icon.png','package.json'],asar:true,npmRebuild:false,win:{icon:path.join(exporterStage,'build/icon.ico'),target:[{target:'dir',arch:['x64']}]}}));
run(process.execPath,[builder,'--projectDir',exporterStage,'--config',exporterConfig,'--win','--dir','--publish','never']);
run(process.execPath,['scripts/build-module-pack.mjs','--id','exporter','--source',path.join(exporterOutput,'win-unpacked'),'--output',output,'--tag','v'+host.version,'--version',JSON.parse(fs.readFileSync(path.join(exporterStage,'package.json'),'utf8')).version,'--entry','LingtuOrderExporter.exe']);

}
const finalSources=suiteSourceDigests(root);
for(const [id,value] of Object.entries(sources))if(finalSources[id]!==value)throw Error('Source changed during suite build: '+id);
const packages=fs.readdirSync(output).filter(n=>n.endsWith('.descriptor.json')).map(n=>JSON.parse(fs.readFileSync(path.join(output,n),'utf8'))).sort((a,b)=>a.id.localeCompare(b.id));
const suite={format:'lingtu-suite/v1',productId:'com.wucheng.ecommerce.erp.v2',version:host.version,components:packages.map(({id,version,sha256})=>({id,version,sha256})),sourceFingerprintVersion:2,sourceDigests:sources};
const payload=Buffer.from(JSON.stringify({schemaVersion:1,publishedAt:new Date().toISOString(),suite,packages}));
const envelope={format:'lingtu-catalog/v1',keyId,payload:payload.toString('base64'),signature:sign(null,payload,key).toString('base64')};
verifyCatalog(envelope,keys,{hostVersion:host.version,platform:'win32',arch:'x64'});
fs.writeFileSync(path.join(output,'catalog.json'),JSON.stringify(envelope,null,2));
fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify({...suite,catalogSha256:await digest(path.join(output,'catalog.json')),packages:packages.map(({id,version,archive,bytes,unpackedBytes,sha256})=>({id,version,archive,bytes,unpackedBytes,sha256}))},null,2));
fs.writeFileSync(path.resolve('dist/suite-payload-current.json'),JSON.stringify({directory:output,version:host.version,catalogSha256:await digest(path.join(output,'catalog.json'))},null,2));
console.log(JSON.stringify({suitePayload:output,version:host.version,components:packages.map(({id,version})=>({id,version}))}));
