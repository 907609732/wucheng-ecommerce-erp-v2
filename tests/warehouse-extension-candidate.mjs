import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import {agentBetaPaths,prepareAgentProfile} from '../desktop/business-host/isolation.mjs';
import {createOnDemandComponents} from '../desktop/business-host/on-demand.mjs';
import {assertSlimShell} from '../scripts/engineering/trim-shell.mjs';
const root=path.resolve(import.meta.dirname,'..');
const candidate=JSON.parse(fs.readFileSync(path.join(root,'.codex-artifacts/engineering/installer-current.json'),'utf8'));
assertSlimShell(candidate.shell);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-extension-candidate-'));
const previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=temporary;
const report={ok:false,fixtureRoot:temporary,installer:candidate.installer,checks:[],realPlatform:false,network:'signed release assets supplied by local test transport'};
try{
 const executable=path.join(candidate.shell,'WuchengAgentPreview.exe'),resources=path.join(candidate.shell,'resources/agent-runtime');
 const paths=agentBetaPaths({localAppData:temporary,preview:true});prepareAgentProfile(paths);Object.assign(paths,{sharedElectronExecutable:executable,sharedElectronVersion:'44.7.0'});
 let calls=0;
 const keys=JSON.parse(fs.readFileSync(path.join(resources,'desktop/launcher/public-keys.json'),'utf8'));
 const nativeEnvironment={...process.env,LINGTU_AGENT_PREVIEW:'1'};delete nativeEnvironment.ELECTRON_RUN_AS_NODE;
 const baseProbe=spawnSync(executable,['--cli','status'],{env:nativeEnvironment,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
 fs.writeFileSync(path.join(root,'.codex-artifacts/warehouse-extension-base-native.log'),baseProbe.stdout+'\n'+baseProbe.stderr);
 assert.equal(baseProbe.status,0,'base host CLI: '+baseProbe.stderr);report.checks.push('actual slim host starts without warehouse code or exclusive dependencies');
 const options={paths,resourcesDir:resources,hostVersion:candidate.version,publicKeys:keys,isBusy:()=>false,fetchImpl:async url=>{
  calls++;const file=path.join(candidate.assets,path.basename(new URL(url).pathname));assert.ok(fs.statSync(file).isFile());
  return new Response(Readable.toWeb(fs.createReadStream(file)),{status:200});
 }};
 const manager=await createOnDemandComponents(options);assert.equal(calls,0);assert.equal((await manager.status('warehouse')).installed,false);
 await assert.rejects(manager.ensure('warehouse'),{code:'MODULE_NOT_INSTALLED'});assert.equal(calls,0);report.checks.push('fresh base has no warehouse and no automatic download');
 await manager.ensure('warehouse',{install:true});assert.equal((await manager.status('warehouse')).installed,true);assert.equal(calls,3);report.checks.push('real signed warehouse/browser/node archives install and initialize isolated ledger');
 const restarted=await createOnDemandComponents(options);assert.equal((await restarted.status('warehouse')).installed,true);await restarted.ensure('warehouse');assert.equal(calls,3);report.checks.push('restart validates installed files without downloading');
 const registry=JSON.parse(fs.readFileSync(paths.registryFile,'utf8'));assert.ok(fs.statSync(path.join(registry.warehouse.dataDir,'workspace/data/erp.sqlite')).size>0);
 const env={...process.env,LINGTU_AGENT_PREVIEW:'1',LINGTU_REGISTRY_PATH:paths.registryFile};delete env.ELECTRON_RUN_AS_NODE;
 const probe=spawnSync(executable,['--agent-component=warehouse','--cli','status','--user-data-dir='+registry.warehouse.dataDir],{env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
 fs.writeFileSync(path.join(root,'.codex-artifacts/warehouse-extension-native.log'),probe.stdout+'\n'+probe.stderr);
 assert.equal(probe.status,0,'native cloud CLI: '+probe.stderr);report.checks.push('shared packaged Electron opens installed warehouse CLI');
 report.ok=true;
}catch(error){report.error=error.stack;throw error;}
finally{
 if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;
 fs.writeFileSync(path.join(root,'.codex-artifacts/warehouse-extension-candidate.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
