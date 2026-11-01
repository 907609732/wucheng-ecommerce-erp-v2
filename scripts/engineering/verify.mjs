import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../../desktop/modules/package-format.mjs';
import {suiteSourceDigests,suiteSourceDigest} from '../suite-source-digests.mjs';
import {globalSourceHash} from '../agent-beta-coverage.mjs';
import {warehouseSource} from './warehouse-extension.mjs';
import {affectedUnits,TEST_UNITS} from './verification-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),level=process.argv[2];
if(!['quick','integration','release'].includes(level))throw Error('Use quick, integration or release');
const directory=path.join(root,'.codex-artifacts/engineering','verify-'+level+'-'+Date.now());fs.mkdirSync(directory,{recursive:true});
const source={warehouseExtension:warehouseSource().sha256,business:suiteSourceDigests(root),desktop:suiteSourceDigest(path.join(root,'desktop')),global:globalSourceHash()};
const report={level,source,startedAt:new Date().toISOString(),phases:[],ok:false};
function phase(name,command,args){
 const started=Date.now(),log=path.join(directory,name+'.log'),fd=fs.openSync(log,'wx');let result;
 try{result=spawnSync(command,args,{cwd:root,windowsHide:true,stdio:['ignore',fd,fd],timeout:20*60*1000,env:{...process.env,ERP_BUILD_PLATFORM:process.platform,ERP_BUILD_ARCH:process.arch,ERP_BUILD_NODE:process.version,ERP_BUILD_ELECTRON:'44.7.0'}});}finally{fs.closeSync(fd);}
 report.phases.push({name,elapsedMs:Date.now()-started,exitCode:result.status,signal:result.signal||null,error:result.error?.message||null,log});
 if(result.status!==0)throw Error(name+' failed; see '+log);
}
try{
 const changed=[];
 for(const args of [['diff','--name-only','HEAD'],['ls-files','--others','--exclude-standard']]){
  const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('Cannot determine changed inputs');changed.push(...result.stdout.trim().split(/\r?\n/).filter(Boolean));
 }
 const selected=level==='quick'&&!process.argv.includes('--all')?affectedUnits(changed):TEST_UNITS;
 report.selectedUnits=selected;
 if(selected.length)phase('node-tests',process.execPath,[path.join(root,'node_modules/turbo/bin/turbo'),'run','verify','--concurrency=2','--continue=always','--summarize',...(level!=='quick'?['--force']:[]),...selected.map(id=>'--filter=@wucheng-build/'+id)]);
 phase('documentation',process.execPath,['scripts/engineering/check-docs.mjs']);
 if(level!=='quick')phase('source-ui',process.execPath,['scripts/engineering/source-ui.mjs']);
 if(level==='release'){
  const candidate=JSON.parse(fs.readFileSync(path.join(root,'.codex-artifacts/engineering/installer-current.json')));
  if(JSON.stringify(candidate.source)!==JSON.stringify(source))throw Error('Installer does not match current source');
  for(const file of candidate.files){const actual=path.join(candidate.assets,file.name);if(fs.statSync(actual).size!==file.bytes||await digest(actual)!==file.sha256)throw Error('Candidate file changed: '+file.name);}
  const evidence=JSON.parse(fs.readFileSync(path.join(root,'.codex-artifacts/engineering/installed-current.json')));
  if(evidence.installerSha256!==await digest(candidate.installer)||JSON.stringify(evidence.source)!==JSON.stringify(source))throw Error('Installation evidence belongs to another source or candidate');
  for(const name of ['cleanInstall','upgrade','rollback','fiveModules','ledgerReadWrite','mcp','cli','downloadFailures','publicAssets'])if(evidence.checks?.[name]!==true)throw Error('Required release acceptance missing: '+name);
  report.installer=candidate.installer;
 }
 const finalSource={warehouseExtension:warehouseSource().sha256,business:suiteSourceDigests(root),desktop:suiteSourceDigest(path.join(root,'desktop')),global:globalSourceHash()};
 if(JSON.stringify(finalSource)!==JSON.stringify(source))throw Error('Source changed during verification; rerun for current source');
 report.ok=true;
}catch(error){report.error=error.message;process.exitCode=1;}
report.elapsedMs=Date.now()-Date.parse(report.startedAt);report.finishedAt=new Date().toISOString();
fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(root,'.codex-artifacts/engineering','verify-'+level+'-current.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,report:path.join(directory,'report.json')}));
