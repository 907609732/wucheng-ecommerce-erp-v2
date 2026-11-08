import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..');
const checker=path.join(root,'deploy/fnos/verify-artifact.mjs');
function fixture(t){
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-artifact-'));
 t.after(()=>fs.rmSync(stage,{recursive:true,force:true}));
 fs.cpSync(path.join(root,'deploy/fnos/wuchengerp'),stage,{recursive:true});
 fs.mkdirSync(path.join(stage,'app/config'),{recursive:true});for(const name of ['privilege','resource'])fs.copyFileSync(path.join(stage,'config',name),path.join(stage,'app/config',name));
 for(const name of fs.readdirSync(path.join(stage,'cmd')))fs.chmodSync(path.join(stage,'cmd',name),0o755);
 fs.writeFileSync(path.join(stage,'manifest'),'appname=wuchengerp\nversion=0.15.0\nplatform=x86\n');
 const elf=Buffer.alloc(64);elf.set([0x7f,69,76,70,2,1]);elf.writeUInt16LE(62,18);
 for(const p of ['runtime/node/bin/node','runtime/chromium/chrome',...['Xvfb','x11vnc','xauth','xkbcomp'].map(n=>'runtime/sysroot/usr/bin/'+n)]){
  const f=path.join(stage,'app',p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,elf,{mode:0o755});
 }
 const html=fs.readFileSync(path.join(root,'tests/fixtures/novnc-v1.6.0-vnc.html'));
 for(const [p,b] of Object.entries({'runtime/novnc/vnc.html':html,'runtime/node/LICENSE':'Node license','runtime/novnc/LICENSE.txt':'MPL-2.0','runtime/sysroot/usr/share/X11/xkb/rules/base':'xkb','runtime/sysroot/usr/share/fonts/X11/misc/fonts.dir':'font','runtime/sysroot/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc':'font','THIRD-PARTY.json':'{}','erp/server/fnos-native/lifecycle.mjs':'export {};','erp/package.json':'{"version":"0.15.0"}'})){
  const f=path.join(stage,'app',p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);
 }
 const files=['server/fnos-native/lifecycle.mjs','package.json'].map(p=>({path:p,sha256:createHash('sha256').update(fs.readFileSync(path.join(stage,'app/erp',p))).digest('hex')}));
 fs.writeFileSync(path.join(stage,'app/erp/web-release.json'),JSON.stringify({schemaVersion:1,accepted:true,acceptance:{ok:true},files}));
 return stage;
}
const run=stage=>spawnSync(process.execPath,[checker,stage],{encoding:'utf8'});
test('complete native artifact validates its private runtime, upstream CSP and accepted release',t=>{
 const stage=fixture(t),r=run(stage);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).platform,'x86');
});

test('artifact accepts official fnpack aligned manifest fields while rejecting duplicate or changed identity',t=>{
 const stage=fixture(t),file=path.join(stage,'manifest');
 // Extracted from the real complete FPK produced by run42519823711/fnpack1.2.3.
 const manifest=fs.readFileSync(path.join(root,'tests/fixtures/fnpack-1.2.3-main-manifest.txt'),'utf8');
 fs.writeFileSync(file,manifest);assert.equal(run(stage).status,0);
 fs.writeFileSync(file,manifest+'appname = other\n');assert.notEqual(run(stage).status,0);
 fs.writeFileSync(file,manifest.replace('= x86','= arm'));assert.notEqual(run(stage).status,0);
});

test('packed manifest preserves every source field and verifies official app archive checksum',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-packed-manifest-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source'),packed=path.join(dir,'manifest'),archive=path.join(dir,'app.tgz');fs.writeFileSync(archive,'actual compressed payload bytes');
 fs.writeFileSync(source,'appname=wuchengerp\nversion=0.15.0\ndesc=原生完整运行时\n');
 const manifest='appname = wuchengerp\nversion = 0.15.0\ndesc = 原生完整运行时\nchecksum = '+createHash('md5').update(fs.readFileSync(archive)).digest('hex')+'\n';fs.writeFileSync(packed,manifest);
 const verify=()=>spawnSync(process.execPath,[path.join(root,'deploy/fnos/verify-packed-manifest.mjs'),source,packed,archive],{encoding:'utf8'});
 assert.equal(verify().status,0);
 for(const invalid of [manifest.replace('原生完整运行时','changed'),manifest+'unexpected=field\n',manifest+'appname=other\n']){fs.writeFileSync(packed,invalid);assert.notEqual(verify().status,0);}
 fs.writeFileSync(packed,manifest);fs.appendFileSync(archive,'corrupt');assert.notEqual(verify().status,0);
});

test('official static metadata duplicates are complete, byte-identical and exclude business config',t=>{
 const stage=fixture(t),config=path.join(stage,'app/config'),file=path.join(config,'privilege'),original=fs.readFileSync(file);
 fs.writeFileSync(file,'{"defaults":{"run-as":"package"}}');assert.notEqual(run(stage).status,0);
 fs.writeFileSync(file,original);fs.writeFileSync(path.join(config,'web.json'),'{}');assert.notEqual(run(stage).status,0);fs.unlinkSync(path.join(config,'web.json'));
 fs.unlinkSync(path.join(config,'resource'));assert.notEqual(run(stage).status,0);
});
test('artifact rejects ledger/config/profile and modified release contents',t=>{
 const stage=fixture(t);
 for(const p of ['app/erp/data/sales/sales.sqlite','app/erp/config/web.json','app/runtime/browser-profiles/Cookies']){
  fs.mkdirSync(path.dirname(path.join(stage,p)),{recursive:true});fs.writeFileSync(path.join(stage,p),'PRIVATE');
  assert.notEqual(run(stage).status,0,p);fs.rmSync(path.join(stage,p.split('/').slice(0,3).join('/')),{recursive:true});
 }
 fs.appendFileSync(path.join(stage,'app/erp/server/fnos-native/lifecycle.mjs'),'changed');assert.notEqual(run(stage).status,0);
});
test('artifact refuses missing runtime, wrong ELF architecture, CRLF hooks and bundled libc',t=>{
 const stage=fixture(t),node=path.join(stage,'app/runtime/node/bin/node'),original=fs.readFileSync(node);
 fs.unlinkSync(node);assert.notEqual(run(stage).status,0);fs.writeFileSync(node,original,{mode:0o755});
 const wrong=Buffer.from(original);wrong.writeUInt16LE(183,18);fs.writeFileSync(node,wrong);assert.notEqual(run(stage).status,0);fs.writeFileSync(node,original);
 const main=path.join(stage,'cmd/main'),hook=fs.readFileSync(main);fs.writeFileSync(main,hook.toString().replaceAll('\n','\r\n'));assert.notEqual(run(stage).status,0);fs.writeFileSync(main,hook);
 const libc=path.join(stage,'app/runtime/sysroot/lib/x86_64-linux-gnu/libc.so.6');fs.mkdirSync(path.dirname(libc),{recursive:true});fs.writeFileSync(libc,original);assert.notEqual(run(stage).status,0);
});
test('upstream noVNC bootstrap hash is checked independently of the source manifest',t=>{
 const stage=fixture(t),f=path.join(stage,'app/runtime/novnc/vnc.html');fs.appendFileSync(f,'<script type="module">alert(1)</script>');assert.notEqual(run(stage).status,0);
});
test('Windows native entry refuses an incomplete thin FPK before invoking any packager',()=>{
 const f=fs.readFileSync(path.join(root,'deploy/fnos/build.ps1'),'utf8');
 assert.match(f,/完整原生|complete native/i);assert.match(f,/build-native\.sh/);assert.doesNotMatch(f,/& \$Fnpack build/);
});
