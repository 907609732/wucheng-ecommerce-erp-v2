import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const output=path.resolve('.codex-artifacts/engineering/source-ui-'+Date.now());fs.mkdirSync(output,{recursive:true});
const log=fs.openSync(path.join(output,'harness.log'),'wx');
const child=spawn(process.execPath,['tests/hybrid-source-harness.mjs','--launch','--debug'],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe',log]});
let buffer='',manifest,browser;
try{
 const launched=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Source fixture startup timed out')),120000);
  child.once('error',error=>{clearTimeout(timeout);reject(error);});
  child.once('exit',code=>{clearTimeout(timeout);reject(Error('Source fixture exited before readiness: '+code));});
  child.stdout.on('data',chunk=>{fs.writeSync(log,chunk);buffer+=chunk;for(const line of buffer.split(/\r?\n/))try{const value=JSON.parse(line);if(value.fixtureRoot&&value.output&&value.pid){clearTimeout(timeout);resolve(value);}}catch{}});
 });
 manifest=JSON.parse(fs.readFileSync(path.join(launched.fixtureRoot,'fixture-manifest.json')));
 const run=spawn(process.execPath,['tests/business-ui-cdp-acceptance.mjs',path.join(launched.fixtureRoot,'fixture-manifest.json')],{cwd:process.cwd(),windowsHide:true,stdio:['ignore',log,log],env:{...process.env,BUSINESS_UI_ACCEPTANCE_OUTPUT:output}});
 const code=await new Promise((resolve,reject)=>{run.once('exit',resolve);run.once('error',reject);});
 if(code!==0)throw Error('Source UI acceptance failed: '+output);
 console.log(JSON.stringify({ok:true,output,scope:'Three real source services and native embedded views; temporary synthetic books; not five-module packaged acceptance'}));
}finally{
 if(manifest)try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+manifest.debugPort);const session=await browser.newBrowserCDPSession();await Promise.race([session.send('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]);}catch{}
 if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]);
 if(child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,10000))]);if(child.exitCode===null)child.kill();}
 fs.closeSync(log);
}
