import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import tailnetResource from '../build/tailnet-resource.cjs';
import {digest,verifyCatalog} from '../desktop/modules/package-format.mjs';
import {suiteSourceDigests} from './suite-source-digests.mjs';
const root=process.cwd();fs.mkdirSync('dist',{recursive:true});
const hostVersion=JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8')).version;
// A deliverable always contains the complete product. --shell-only is restricted
// to isolated developer directory/prepare checks, never an installer release.
const shellOnly=process.argv.includes('--shell-only');
if(shellOnly&&!process.argv.includes('--dir')&&!process.argv.includes('--prepare-only'))throw Error('A distributed workbench must include its complete suite');
let suiteDirectory;
if(!shellOnly){
  suiteDirectory=process.env.LINGTU_SUITE_DIRECTORY;
  if(!suiteDirectory){
    const suiteBuild=spawnSync(process.execPath,[path.join(root,'scripts/build-suite-payload.mjs')],{cwd:root,stdio:'inherit',windowsHide:true});
    if(suiteBuild.status!==0)throw Error('Full business suite build failed');
    suiteDirectory=JSON.parse(fs.readFileSync('dist/suite-payload-current.json','utf8')).directory;
  }
  suiteDirectory=path.resolve(suiteDirectory);
  const envelope=JSON.parse(fs.readFileSync(path.join(suiteDirectory,'catalog.json'),'utf8'));
  const catalog=verifyCatalog(envelope,JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8')),{hostVersion,platform:'win32',arch:'x64'});
  if(catalog.suite?.version!==hostVersion||catalog.packages.length!==7)throw Error('Suite payload belongs to another workbench release');
  const retainedState=process.argv.find(arg=>arg.startsWith('--retained-component-state='))?.slice('--retained-component-state='.length);
  if(retainedState){
    // An explicit launcher-only maintenance build retains the exact signed
    // components already installed. Concurrent business source edits are NOT
    // packaged. Never silently relax the normal source-fingerprint gate.
    if(!path.isAbsolute(retainedState)||fs.lstatSync(retainedState).isSymbolicLink())throw Error('Retained component receipt must be an absolute regular file');
    const installed=JSON.parse(fs.readFileSync(retainedState,'utf8'));
    for(const spec of catalog.packages)if(installed.packages?.[spec.id]?.version!==spec.version||installed.packages[spec.id].sha256!==spec.sha256)throw Error('Launcher-only update would replace a business/runtime component: '+spec.id);
    console.log(JSON.stringify({launcherOnlyMaintenance:true,retainedSignedComponents:catalog.packages.map(({id,version})=>({id,version})),concurrentBusinessSourceNotIncluded:true}));
  }else if(JSON.stringify(catalog.suite.sourceDigests)!==JSON.stringify(suiteSourceDigests(root)))throw Error('Suite payload is stale or belongs to another workbench source revision');
  for(const spec of catalog.packages){catalog.compatible(spec);const file=path.join(suiteDirectory,spec.archive);if(fs.statSync(file).size!==spec.bytes||await digest(file)!==spec.sha256)throw Error('Suite payload digest mismatch: '+spec.id);}
}
// Validate before npm/build work. Only a frozen, public runtime snapshot is
// passed to electron-builder; no state directory or developer Go SDK is copied.
const tailnetSource=tailnetResource.validateTailnetResource(path.join(root,'dist/tailnet-runtime'));
tailnetResource.verifyTailnetVersion(tailnetSource);
const tailnet=fs.mkdtempSync(path.resolve('dist/tailnet-resource-'));
const tailnetSnapshot=tailnetResource.copyTailnetResource(tailnetSource.root,tailnet);
const stage=fs.mkdtempSync(path.resolve('dist/launcher-app-'));
const files=['desktop/launcher','desktop/modules','desktop/local-desks.mjs','desktop/extension-preload.cjs',
  'desktop/workbench-client','desktop/workbench-migration/coordinator.mjs','desktop/workbench-migration/service-adapter.mjs','desktop/workbench-migration/local-data-move.mjs','desktop/workbench-migration/verify-pending-entry.mjs','desktop/workbench/actor.mjs','desktop/workbench/policy.mjs',
  'desktop/shared','desktop/workbench/manifest.mjs','desktop/workbench/descriptors.mjs',
  'desktop/extensions/lingtu-desks','desktop/updater.mjs','desktop/mcp-stdio-entry.mjs','desktop/mcp-server.mjs','desktop/assets/lingtu-icon.png'];
for(const relative of files)fs.cpSync(path.join(root,relative),path.join(stage,relative),{recursive:true,filter:file=>!file.endsWith(path.join('modules','cloud-control.mjs'))});
if(suiteDirectory)fs.copyFileSync(path.join(suiteDirectory,'catalog.json'),path.join(stage,'desktop/launcher/catalog.json'));
// The foreground shell contains no ledger or business credentials. Business
// code is a verified suite resource, outside its ASAR and independent of data.
const wanted=['yauzl','semver','electron-updater','@modelcontextprotocol/server','zod','fastify'];
const dependencies=Object.fromEntries(wanted.map(name=>[name,JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8')).version]));
const pkg={name:'wucheng-ecommerce-erp-v2',version:JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8')).version,productName:'五成电子商务工作台',description:'五成电子商务工作台',author:'五成电子商务集团',private:true,type:'module',main:'desktop/launcher/main.mjs',dependencies};
fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(pkg,null,2));
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
lock.name=pkg.name;lock.version=pkg.version;lock.packages['']={name:pkg.name,version:pkg.version,dependencies};
fs.writeFileSync(path.join(stage,'package-lock.json'),JSON.stringify(lock,null,2));
const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const install=spawnSync(process.execPath,[npmCli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit',windowsHide:true});
if(install.status!==0)throw Error('Launcher dependency installation failed');
// The detached gateway uses the shared Node runtime and ordinary files, so a host
// upgrade cannot terminate it or point Node at an Electron ASAR archive.
const gateway=fs.mkdtempSync(path.resolve('dist/workbench-gateway-'));
for(const relative of [...['actor','descriptors','gateway','manifest','policy','server','store'].map(name=>'desktop/workbench/'+name+'.mjs'),'desktop/workbench-migration','desktop/shared/service-manager.mjs','desktop/shared/user-data-path.mjs','desktop/shared/workbench-location.mjs'])fs.cpSync(path.join(root,relative),path.join(gateway,relative),{recursive:true});
const gatewayDependencies=Object.fromEntries(['fastify','@fastify/reply-from','@fastify/cookie'].map(name=>[name,JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8')).version]));
fs.writeFileSync(path.join(gateway,'package.json'),JSON.stringify({name:'lingtu-workbench-gateway',version:pkg.version,private:true,type:'module',dependencies:gatewayDependencies},null,2));
const gatewayLock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));gatewayLock.name='lingtu-workbench-gateway';gatewayLock.version=pkg.version;gatewayLock.packages['']={name:gatewayLock.name,version:pkg.version,dependencies:gatewayDependencies};
fs.writeFileSync(path.join(gateway,'package-lock.json'),JSON.stringify(gatewayLock));
const gatewayInstall=spawnSync(process.execPath,[npmCli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:gateway,stdio:'inherit',windowsHide:true});
if(gatewayInstall.status!==0)throw Error('Gateway dependency installation failed');
if(process.argv.includes('--prepare-only')){
  console.log(JSON.stringify({preparedOnly:true,stage,gateway,tailnet,suiteDirectory,tailnetFingerprint:tailnetSnapshot.fingerprint,output:path.join(root,'dist/launcher-release')}));
  process.exit(0);
}
const config=path.join(root,'build/launcher-builder.config.cjs');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--projectDir',stage,'--config',config,'--win',...(process.argv.includes('--dir')?['--dir']:['nsis']),'--publish','never'],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,LINGTU_GATEWAY_RESOURCE:gateway,LINGTU_TAILNET_RESOURCE:tailnet,LINGTU_TAILNET_FINGERPRINT:tailnetSnapshot.fingerprint,...(suiteDirectory?{LINGTU_SUITE_RESOURCE:suiteDirectory}:{LINGTU_SHELL_ONLY:'1'})}});
if(result.status!==0)throw Error('Launcher build failed');
console.log(JSON.stringify({stage,output:path.join(root,'dist/launcher-release')}));
