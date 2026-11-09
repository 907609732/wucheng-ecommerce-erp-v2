import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

test('standalone collector contains a heartbeat write failure and closes its owned resources before exit', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collector-heartbeat-'));
  const entry=path.join(dir,'child.mjs'), disconnected=path.join(dir,'disconnected');
  fs.writeFileSync(entry,`
    import fs from 'node:fs';import path from 'node:path';
    import {startCollector} from ${JSON.stringify(pathToFileURL(path.resolve('server/collector.mjs')).href)};
    const dir=${JSON.stringify(dir)},target=path.join(dir,'sales','.web-collector.json');
    let armed=false;const rename=fs.renameSync;
    fs.renameSync=function(from,to){if(armed&&to===target)throw Object.assign(Error('fixture-secret-path'),{code:'EPERM'});return rename.apply(this,arguments);};
    await startCollector({modules:Object.fromEntries(['sales','overview'].map(id=>[id,{dataDir:path.join(dir,id)}]))},{factory:async id=>({status:()=>({status:'disconnected'}),disconnect:async()=>fs.appendFileSync(${JSON.stringify(disconnected)},id+'\\n')})});
    armed=true;
  `);
  const child=spawn(process.execPath,[entry],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await closed;}fs.rmSync(dir,{recursive:true,force:true});});
  const outcome=await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('collector did not exit')),8000);timer.unref();})]);
  assert.equal(outcome.code,1,stderr);
  assert.equal(fs.existsSync(disconnected),true,'heartbeat failure must disconnect owned adapters before exit');
  assert.deepEqual(fs.readFileSync(disconnected,'utf8').trim().split('\n').sort(),['overview','sales']);
  for(const id of ['sales','overview'])assert.equal(fs.existsSync(path.join(dir,id,'.web-collector.json')),false,'failed collector must remove its discovery record');
  assert.match(stderr,/EPERM/);
  assert.doesNotMatch(stderr,/fixture-secret-path|Timeout\.publish/,'failure report must be controlled and sanitized');
});

for(const trigger of ['heartbeat','operation'])test(`failed owned collector (${trigger}) rejects new work, permits drain disconnect and stops idempotently`,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collector-owner-failure-'));
  const entry=path.join(dir,'child.mjs'),report=path.join(dir,'report.json');
  fs.writeFileSync(entry,`
    import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
    import {startCollector} from ${JSON.stringify(pathToFileURL(path.resolve('server/collector.mjs')).href)};
    import {CollectorBrowser} from ${JSON.stringify(pathToFileURL(path.resolve('server/collector-client.mjs')).href)};
    const dir=${JSON.stringify(dir)},target=path.join(dir,'sales','.web-collector.json');
    let armed=false,disconnects=0,calls=0,notifications=0;const rename=fs.renameSync;
    fs.renameSync=function(from,to){if(armed&&to===target)throw Object.assign(Error('private-path'),{code:'EPERM'});return rename.apply(this,arguments);};
    const helper=await startCollector({modules:Object.fromEntries(['sales','overview'].map(id=>[id,{dataDir:path.join(dir,id)}]))},{
      factory:async()=>({status:()=>({status:'connected'}),disconnect:async()=>{disconnects++;},run:async()=>{calls++;}}),
      onError:async()=>{
        notifications++;assert.equal(helper.status().ok,false);
        const browser=new CollectorBrowser(path.join(dir,'sales'));
        await assert.rejects(browser.run('account'),/采集助手状态写入失败/);
        await browser.disconnect();
        await Promise.all([helper.stop(),helper.stop()]);
        fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({disconnects,calls,notifications}));
      }
    });armed=true;
    if(${JSON.stringify(trigger)}==='operation')await assert.rejects(new CollectorBrowser(path.join(dir,'sales')).run('account'),/采集助手状态写入失败/);
  `);
  const child=spawn(process.execPath,[entry],{windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await closed;}fs.rmSync(dir,{recursive:true,force:true});});
  const code=await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('owned collector did not exit')),8000);timer.unref();})]);
  assert.equal(code,1,stderr);
  assert.equal(fs.existsSync(report),true,stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(report)),{disconnects:3,calls:trigger==='operation'?1:0,notifications:1});
  assert.equal((stderr.match(/采集助手状态写入失败/g)||[]).length,1,'report first failure once');
  assert.doesNotMatch(stderr,/private-path/);
});
