import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const workspace=process.env.GITHUB_WORKSPACE,inputs=process.env.VERIFIED_INPUT_ROOT,tools=path.join(workspace,'ci-tools'),appRoot=path.join(inputs,'app'),suite=path.join(workspace,'signed-suite'),output=path.join(workspace,'installer-output');
const repo='907609732/wucheng-ecommerce-erp-v2',tag='0.11.3';fs.mkdirSync(suite,{recursive:true});
function run(file,args,opts={}){const p=spawnSync(file,args,{cwd:workspace,windowsHide:true,stdio:'inherit',...opts});if(p.status!==0)throw Error('Command failed: '+path.basename(file)+' '+args[0]);return p;}
const gh=process.platform==='win32'?'gh.exe':'gh';
run(gh,['release','download',tag,'--repo',repo,'--pattern','catalog.json','--pattern','release-manifest.json','--dir',suite]);
const {verifyCatalog,digest}=await import(pathToFileURL(path.join(appRoot,'desktop/modules/package-format.mjs')));
const catalog=verifyCatalog(JSON.parse(fs.readFileSync(path.join(suite,'catalog.json'),'utf8')),JSON.parse(fs.readFileSync(path.join(appRoot,'desktop/launcher/public-keys.json'),'utf8')),{hostVersion:tag,platform:'win32',arch:'x64'});
if(catalog.packages.length!==7||catalog.suite.version!==tag||catalog.packages.find(p=>p.id==='purchase').version!=='1.8.0')throw Error('Unexpected frozen suite');
for(const p of catalog.packages){run(gh,['release','download',tag,'--repo',repo,'--pattern',p.archive,'--dir',suite]);if(await digest(path.join(suite,p.archive))!==p.sha256||fs.statSync(path.join(suite,p.archive)).size!==p.bytes)throw Error('Component digest differs: '+p.id);}
const require=createRequire(path.join(appRoot,'package.json')),tailnet=require(path.join(appRoot,'build/tailnet-resource.cjs'));const tailnetRoot=path.join(inputs,'tailnet-runtime'),validated=tailnet.validateTailnetResource(tailnetRoot);tailnet.verifyTailnetVersion(validated);
const config=path.join(appRoot,'build/ci-builder.cjs');fs.writeFileSync(config,'const base=require("./launcher-builder.config.cjs");module.exports={...base,electronDist:'+JSON.stringify(path.join(tools,'node_modules/electron/dist'))+',directories:{output:'+JSON.stringify(output)+'},win:{...base.win,target:[{target:"nsis",arch:["x64"]}]}};');
run(process.execPath,[path.join(tools,'node_modules/electron-builder/cli.js'),'--projectDir',appRoot,'--config',config,'--win','nsis','--publish','never'],{env:{...process.env,LINGTU_GATEWAY_RESOURCE:path.join(inputs,'gateway'),LINGTU_TAILNET_RESOURCE:tailnetRoot,LINGTU_TAILNET_FINGERPRINT:validated.fingerprint,LINGTU_SUITE_RESOURCE:suite}});
const asar=createRequire(path.join(tools,'package.json'))('@electron/asar'),archive=path.join(output,'win-unpacked/resources/app.asar');let firstParty=0;
for(const entry of asar.listPackage(archive)){const rel=entry.replaceAll('\\','/').replace(/^\//,'');if(rel.startsWith('node_modules/'))continue;const metadata=asar.statFile(archive,path.normalize(rel));if(metadata.files)continue;firstParty++;const source=path.join(appRoot,rel);if(!fs.existsSync(source)||!asar.extractFile(archive,path.normalize(rel)).equals(fs.readFileSync(source)))throw Error('First-party payload differs: '+rel);}
const test=path.join(tools,'suite-acceptance.mjs');fs.copyFileSync(path.join(workspace,'release-sources/0.11.3/ci/suite-acceptance.mjs'),test);const exe=path.join(output,'win-unpacked/云仓库存同步.exe'),reportFile=path.join(workspace,'dist/module-verification/suite-isolated-0.11.3.json');
let result=spawnSync(exe,[test],{cwd:workspace,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8',timeout:900000});if(result.stdout)console.log(result.stdout);if(result.stderr)console.log(result.stderr);
let acceptance=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile,'utf8')):null;
if(!acceptance?.ok&&acceptance?.checks?.length===0&&/无法确认旧模块已退出/.test(acceptance.error||'')){result=spawnSync(exe,[test],{cwd:workspace,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LINGTU_ACCEPTANCE_FIXTURE:acceptance.fixture},windowsHide:true,encoding:'utf8',timeout:900000});if(result.stdout)console.log(result.stdout);if(result.stderr)console.log(result.stderr);acceptance=JSON.parse(fs.readFileSync(reportFile,'utf8'));}
if(result.status!==0||!acceptance?.ok||acceptance.moduleDownloads!==0)throw Error('Isolated candidate acceptance failed');
const publicAcceptance={ok:true,version:tag,purchase:'1.8.0',checks:acceptance.checks,moduleDownloads:0,firstPartyFilesVerified:firstParty,retainedComponents:6,versions:acceptance.versions,distribution:'NSIS installer only',sourceCommit:process.env.GITHUB_SHA,buildRun:process.env.GITHUB_SERVER_URL+'/'+repo+'/actions/runs/'+process.env.GITHUB_RUN_ID};
fs.writeFileSync(path.join(output,'CLOUD-BUILD-ACCEPTANCE.json'),JSON.stringify(publicAcceptance,null,2));
const setup='CloudWarehouseInventorySync-Setup-0.11.3-x64.exe',names=[setup,setup+'.blockmap','latest.yml','CLOUD-BUILD-ACCEPTANCE.json'];const hashes=[];
for(const name of names){const file=path.join(output,name);hashes.push({name,bytes:fs.statSync(file).size,sha256:await digest(file)});}
const yml=fs.readFileSync(path.join(output,'latest.yml'),'utf8'),actual=createHash('sha512').update(fs.readFileSync(path.join(output,setup))).digest('base64');if(!yml.includes(actual))throw Error('Updater digest mismatch');
fs.writeFileSync(path.join(output,'CLOUD-ARTIFACTS.json'),JSON.stringify(hashes,null,2));
run(gh,['release','upload',tag,...[...names,'CLOUD-ARTIFACTS.json'].map(n=>path.join(output,n)),'--clobber','--repo',repo]);
console.log(JSON.stringify({ok:true,version:tag,installerOnly:true,uploaded:names,firstPartyFilesVerified:firstParty}));
