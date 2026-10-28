import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import asar from '@electron/asar';
import resource from '../build/tailnet-resource.cjs';

const root=process.cwd(),require=createRequire(import.meta.url),actual=process.env.LAUNCHER_TAILNET_APP_OUT;
const expectedDirectory=process.env.LAUNCHER_TAILNET_RESOURCE||path.join(root,'dist/tailnet-runtime');
const expected=resource.validateTailnetResource(expectedDirectory);
let temporary,appOutDir=actual&&path.resolve(actual),ancestorFallbackRejected=false,primaryError;
try{
 if(!appOutDir){
  const stage=process.env.LAUNCHER_TAILNET_PREPARED_STAGE,gateway=process.env.LAUNCHER_TAILNET_GATEWAY_STAGE;
  assert(stage&&gateway,'Provide LAUNCHER_TAILNET_APP_OUT, or explicit prepared launcher/gateway stages; no stale candidate fallback');
  assert(fs.existsSync(path.join(stage,'node_modules/fastify/package.json')),'Prepared launcher lacks production broker dependency');
  temporary=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-launcher-tailnet-packaged-'));
  appOutDir=path.join(temporary,'app');fs.cpSync(path.join(root,'node_modules/electron/dist'),appOutDir,{recursive:true});
  const original=path.join(appOutDir,'electron.exe'),renamed=path.join(appOutDir,'云仓库存同步.exe');
  assert.equal(path.dirname(original),appOutDir);assert.equal(path.dirname(renamed),appOutDir);fs.renameSync(original,renamed);
  fs.mkdirSync(path.join(appOutDir,'resources'),{recursive:true});
  const fixtureIgnored=path.resolve(stage).replaceAll('\\','/')+'/node_modules/**/{test,tests,__tests__,example,examples,benchmark,benchmarks}';
  await asar.createPackageWithOptions(path.resolve(stage),path.join(appOutDir,'resources/app.asar'),{globOptions:{ignore:[fixtureIgnored,fixtureIgnored+'/**']}});
  const gatewayTarget=path.join(appOutDir,'resources/workbench-gateway');
  fs.cpSync(path.resolve(gateway),gatewayTarget,{recursive:true,filter:file=>!/(?:^|[\\/])(?:test|tests|__tests__|examples|benchmark|benchmarks)(?:[\\/]|$)/.test(path.relative(gateway,file))});
  resource.copyTailnetResource(expected.root,path.join(appOutDir,'resources/tailnet-runtime'));

  // A missing ASAR dependency must not be rescued by an ambient ancestor.
  const brokenSource=path.join(temporary,'broken-source'),brokenApp=path.join(temporary,'broken-app');
  fs.mkdirSync(path.join(brokenSource,'desktop'),{recursive:true});fs.cpSync(path.join(stage,'desktop/workbench-client'),path.join(brokenSource,'desktop/workbench-client'),{recursive:true});
  fs.writeFileSync(path.join(brokenSource,'package.json'),JSON.stringify({type:'module',dependencies:{fastify:'*'}}));
  fs.mkdirSync(path.join(brokenApp,'resources'),{recursive:true});await asar.createPackage(brokenSource,path.join(brokenApp,'resources/app.asar'));
  resource.copyTailnetResource(expected.root,path.join(brokenApp,'resources/tailnet-runtime'));
  const ambient=path.join(temporary,'node_modules/fastify');fs.mkdirSync(ambient,{recursive:true});fs.writeFileSync(path.join(ambient,'package.json'),JSON.stringify({name:'fastify',version:'0.0.0-ambient-fixture',main:'index.cjs'}));fs.writeFileSync(path.join(ambient,'index.cjs'),'module.exports = function () {};');
  assert.throws(()=>resource.probePackagedTailnet({appOutDir:brokenApp,electronPath:renamed,expected}),error=>{
   assert.equal(error.code,'PACKAGED_TAILNET_INERT_PROBE_FAILED');assert.match(error.details,/outside ASAR|Cannot find module ['"]fastify/);return true;
  });ancestorFallbackRejected=true;
 }
 const previous=process.env.LINGTU_TAILNET_RESOURCE,previousFingerprint=process.env.LINGTU_TAILNET_FINGERPRINT;process.env.LINGTU_TAILNET_RESOURCE=expected.root;process.env.LINGTU_TAILNET_FINGERPRINT=expected.fingerprint;
 try{const config=require('../build/launcher-builder.config.cjs');await config.afterPack({appOutDir});}
 finally{if(previous===undefined)delete process.env.LINGTU_TAILNET_RESOURCE;else process.env.LINGTU_TAILNET_RESOURCE=previous;if(previousFingerprint===undefined)delete process.env.LINGTU_TAILNET_FINGERPRINT;else process.env.LINGTU_TAILNET_FINGERPRINT=previousFingerprint;}
 const report={ok:true,packagedResourceHook:true,actualUnpackedCandidate:Boolean(actual),preparedProductionFixture:!actual,ancestorFallbackRejected:actual?'covered by prepared fixture acceptance':ancestorFallbackRejected,resourceFingerprint:expected.fingerprint,componentSHA256:expected.manifest.sha256,realStart:false,realLogin:false,realProfileUsed:false,fullElectronBuilderRun:false};
 if(process.env.LAUNCHER_TAILNET_REPORT)fs.writeFileSync(path.resolve(process.env.LAUNCHER_TAILNET_REPORT),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}catch(error){primaryError=error;throw error;}finally{
 if(temporary){
  const resolved=fs.realpathSync(temporary),relative=path.relative(fs.realpathSync(os.tmpdir()),resolved);assert(!relative.includes(path.sep)&&relative.startsWith('lingtu-launcher-tailnet-packaged-'));
  try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
  catch(error){console.error(JSON.stringify({temporaryFixtureCleanupIncomplete:true,path:resolved,code:error.code}));if(!primaryError)throw error;}
 }
}
