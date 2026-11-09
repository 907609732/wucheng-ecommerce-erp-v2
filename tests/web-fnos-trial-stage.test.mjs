import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareTrialStage} from '../deploy/fnos/prepare-trial-stage.mjs';

test('generated trial stage owns its app, UI, data and safe synthetic-only wizard', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-trial-stage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const main=path.resolve('deploy/fnos/wuchengerp'),trial=path.join(root,'wuchengerptrial');
 fs.mkdirSync(path.join(root,'source/app'),{recursive:true});
 const source=path.join(root,'source');fs.cpSync(main,source,{recursive:true});
 const links=path.join(source,'app/runtime');fs.mkdirSync(links,{recursive:true});
 fs.writeFileSync(path.join(links,'libsample.so.1'),'fixture');
 if(process.platform!=='win32') fs.symlinkSync('libsample.so.1',path.join(links,'libsample.so'));
 fs.writeFileSync(path.join(source,'app/THIRD-PARTY.json'),JSON.stringify({packageName:'wuchengerp',xvfbBuild:{xkbBinDir:'/var/apps/wuchengerp/target/runtime/sysroot/usr/bin',xkbDir:'/var/apps/wuchengerp/target/runtime/sysroot/usr/share/X11/xkb'}}));
 const mainHook=fs.readFileSync(path.join(source,'cmd/native_env'));
 const mainRecovery=fs.readFileSync(path.join(source,'cmd/retained_recovery.py'));
 prepareTrialStage(source,trial);
 assert.deepEqual(fs.readFileSync(path.join(source,'cmd/native_env')),mainHook);
 assert.deepEqual(fs.readFileSync(path.join(source,'cmd/retained_recovery.py')),mainRecovery);
 const manifest=fs.readFileSync(path.join(trial,'manifest'),'utf8');
 assert.match(manifest,/^appname=wuchengerptrial$/m);assert.match(manifest,/^desktop_applaunchname=wuchengerptrial\.main$/m);assert.match(manifest,/隔离验收/);
 const ui=JSON.parse(fs.readFileSync(path.join(trial,'app/ui/config'),'utf8'));
 assert.deepEqual(Object.keys(ui['.url']),['wuchengerptrial.main']);
 assert.equal(ui['.url']['wuchengerptrial.main'].gatewayPrefix,'/app/wuchengerptrial');
 assert.equal(ui['.url']['wuchengerptrial.main'].gatewaySocket,'app.sock');
 const hook=fs.readFileSync(path.join(trial,'cmd/native_env'),'utf8');
 assert.match(hook,/ERP_NATIVE_BASE_PREFIX=\/app\/wuchengerptrial/);assert.match(hook,/BASE="\$VOLUME\/@wuchengerptrial-data"/);
 assert.ok(hook.indexOf('隔离试装禁止迁移')<hook.indexOf('TRIM_APPDEST_VOL'));
 const shell=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'sh';
 const refused=spawnSync(shell,['-c','erp_mode=migrate; . "$1"','sh',path.join(trial,'cmd/native_env')],{encoding:'utf8'});
 assert.notEqual(refused.status,0);assert.match(refused.stderr,/隔离试装禁止迁移/);assert.doesNotMatch(refused.stderr,/缺少持久存储卷/);
 const recovery=fs.readFileSync(path.join(trial,'cmd/retained_recovery.py'),'utf8');
 assert.equal((recovery.match(/'@wuchengerptrial-data'/g)||[]).length,2);assert.doesNotMatch(recovery,/@wuchengerp-data/);
 for(const name of ['install_callback','upgrade_callback']) assert.match(fs.readFileSync(path.join(trial,'cmd',name),'utf8'),/erp_mode:-.*migrate.*fail/);
 const install=JSON.parse(fs.readFileSync(path.join(trial,'wizard/install'),'utf8'));
 const text=JSON.stringify(install);assert.match(text,/新建三个合成账本/);assert.match(text,/沿用本试装自身数据/);
 assert.equal(install.flatMap(page=>page.items||[]).flatMap(item=>item.options||[]).some(option=>option.value==='migrate'),false);
 const upgrade=JSON.parse(fs.readFileSync(path.join(trial,'wizard/upgrade'),'utf8'));
 assert.equal(upgrade.flatMap(page=>page.items||[]).flatMap(item=>item.options||[]).some(option=>option.value==='migrate'),false);
 const third=JSON.parse(fs.readFileSync(path.join(trial,'app/THIRD-PARTY.json'),'utf8'));
 assert.equal(third.packageName,'wuchengerptrial');assert.match(third.xvfbBuild.xkbBinDir,/wuchengerptrial/);
 if(process.platform!=='win32') assert.equal(fs.readlinkSync(path.join(trial,'app/runtime/libsample.so')),'libsample.so.1');
 assert.equal(fs.readFileSync(path.join(source,'app/runtime/libsample.so.1'),'utf8'),'fixture');
 const pythonCandidates=process.platform==='win32'
  ? [path.join(process.env.LOCALAPPDATA||'','Programs/Python/Python312/python.exe'),'python']
  : ['python3','python'];
 const python=pythonCandidates.map(command=>({command,...spawnSync(command,['-c','import sys; print(sys.executable)'],{encoding:'utf8'})})).find(result=>result.status===0);
 assert.ok(python,'A system Python interpreter is required for the generated hook syntax check');
 const syntax=spawnSync(python.command,['-c','import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())',path.join(trial,'cmd/retained_recovery.py')],{encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
});

test('trial stage generator refuses an existing target', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-trial-existing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const main=path.resolve('deploy/fnos/wuchengerp'),trial=path.join(root,'target');fs.mkdirSync(trial);
 assert.throws(()=>prepareTrialStage(main,trial),/new path/);
});
