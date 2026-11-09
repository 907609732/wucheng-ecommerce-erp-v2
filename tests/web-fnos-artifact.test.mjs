import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {manifestFields} from '../deploy/fnos/verify-artifact.mjs';
import {acceptedNativeRelease,writeNativeManifest} from '../deploy/fnos/write-native-manifest.mjs';

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
 for(const p of ['chromium/libvulkan.so.1','chromium/libvk_swiftshader.so','chromium/vk_swiftshader_icd.json','sysroot/usr/lib/x86_64-linux-gnu/gio/modules/libdconfsettings.so',...['libnss_mymachines.so.2','libnss_mdns4_minimal.so.2','libva.so.2','libva-drm.so.2','libvulkan_intel.so','libvulkan_radeon.so'].map(n=>'sysroot/usr/lib/x86_64-linux-gnu/'+n)]){const file=path.join(stage,'app/runtime',p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,elf);}
 fs.writeFileSync(path.join(stage,'app/runtime/chromium/vk_swiftshader_icd.json'),JSON.stringify({ICD:{library_path:'./libvk_swiftshader.so'}}));
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
test('native artifact version follows the hash-verified accepted release package',t=>{
 const stage=fixture(t),packageFile=path.join(stage,'app/erp/package.json'),releaseFile=path.join(stage,'app/erp/web-release.json');
 fs.writeFileSync(packageFile,JSON.stringify({version:'0.16.3'}));
 const release=JSON.parse(fs.readFileSync(releaseFile,'utf8'));
 release.files.find(item=>item.path==='package.json').sha256=createHash('sha256').update(fs.readFileSync(packageFile)).digest('hex');
 fs.writeFileSync(releaseFile,JSON.stringify(release));
 const identity=acceptedNativeRelease(path.join(stage,'app/erp'));assert.equal(identity.version,'0.16.3');assert.equal(identity.sourceCompanion,'wuchengerp-0.16.3-corresponding-source.tar.zst');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-version-manifest-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 for(const file of ['debian-packages.json','sharp-source-inputs.json','canvas-source-inputs.json'])fs.writeFileSync(path.join(work,file),'{}');
 const thirdParty=writeNativeManifest(stage,work);assert.equal(thirdParty.version,'0.16.3');assert.equal(thirdParty.sourceCompanion,'wuchengerp-0.16.3-corresponding-source.tar.zst');
 const manifestFile=path.join(stage,'manifest'),manifest=fs.readFileSync(manifestFile,'utf8');
 fs.writeFileSync(manifestFile,manifest.replace('version=0.15.0','version=0.16.3'));
 const result=run(stage);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).version,'0.16.3');
 fs.writeFileSync(manifestFile,manifest);assert.notEqual(run(stage).status,0,'manifest/package version mismatch must fail');
 fs.writeFileSync(packageFile,JSON.stringify({version:'0.16'}));
 release.files.find(item=>item.path==='package.json').sha256=createHash('sha256').update(fs.readFileSync(packageFile)).digest('hex');
 fs.writeFileSync(releaseFile,JSON.stringify(release));
 fs.writeFileSync(manifestFile,manifest.replace('version=0.15.0','version=0.16'));
 assert.notEqual(run(stage).status,0,'invalid accepted release package version syntax must fail');
});
test('artifact requires dlopen payload but permits external NSS plugins without bundling glibc NSS',t=>{
 const stage=fixture(t);assert.equal(run(stage).status,0,'external NSS plugins are not glibc');
 for(const p of ['chromium/libvulkan.so.1','chromium/libvk_swiftshader.so','chromium/vk_swiftshader_icd.json','sysroot/usr/lib/x86_64-linux-gnu/gio/modules/libdconfsettings.so',...['libnss_mymachines.so.2','libnss_mdns4_minimal.so.2','libva.so.2','libva-drm.so.2','libvulkan_intel.so','libvulkan_radeon.so'].map(n=>'sysroot/usr/lib/x86_64-linux-gnu/'+n)]){
  const file=path.join(stage,'app/runtime',p),bytes=fs.readFileSync(file);fs.unlinkSync(file);assert.notEqual(run(stage).status,0,p+' must not silently fall back to host');fs.writeFileSync(file,bytes);
 }
 const file=path.join(stage,'app/runtime/sysroot/usr/lib/x86_64-linux-gnu/libnss_files.so.2');fs.writeFileSync(file,'host glibc must remain external');assert.notEqual(run(stage).status,0);
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
 for(const invalid of [manifest.replace('原生完整运行时','changed'),manifest+'unexpected=field\n',manifest+'__proto__=ignored-extra\n',manifest+'__proto__=first\n__proto__=duplicate\n',manifest+'appname=other\n']){fs.writeFileSync(packed,invalid);assert.notEqual(verify().status,0);}
 fs.writeFileSync(packed,manifest);fs.appendFileSync(archive,'corrupt');assert.notEqual(verify().status,0);
});

test('diagnostic source declares the complete actual official fnpack manifest field set',()=>{
 const build=fs.readFileSync(path.join(root,'deploy/fnos/build-diagnostic.sh'),'utf8');
 const source=manifestFields(build.match(/cat > "\$diag\/manifest" <<'?EOF'?\r?\n([\s\S]*?)\r?\nEOF/)[1]);
 // Entire real diagnostic manifest from run42526258527/fnpack1.2.3, with only
 // trailing spaces on the two empty values normalized. Full archive
 // MD5 is separately checked against that downloaded actual 624MB app.tgz.
 const packed=manifestFields(fs.readFileSync(path.join(root,'tests/fixtures/fnpack-1.2.3-diagnostic-manifest.txt'),'utf8'));
 assert.equal(source.version,'$main_version');assert.match(build,/main_version=\$\(awk[\s\S]*?\$stage\/manifest/);assert.match(build,/\[\[ \$main_version =~ \^\[0-9\]/);
 source.version=packed.version;
 for(const [key,value] of Object.entries(source))assert.equal(packed[key],value,key);
 assert.deepEqual(Object.keys(packed).filter(k=>k!=='checksum').sort(),Object.keys(source).sort());
 assert.equal(packed.desktop_uidir,'');assert.equal(packed.desktop_applaunchname,'');
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
