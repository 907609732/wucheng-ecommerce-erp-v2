import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const raw=body=>'### Result\n'+JSON.stringify(body)+'\n### Ran Playwright code\n```js\nawait page.evaluate(...);\n```';
const current='Sandbox Status\nLayer 1 Sandbox\tNamespace\nPID namespaces\tYes\nNetwork namespaces\tYes\nSeccomp-BPF sandbox\tYes\nYou are adequately sandboxed.';
test('single-browser smoke rejects an extra owned overview stack instead of counting sales alone',async()=>{
 const {verifySharedBrowserProcesses}=await import('../deploy/fnos/smoke-checks.mjs');
 const profileRoot='/fixture/data/browser-profiles',launchRoot='/fixture/data/state/native-browser',run=launchRoot+'/01234567-89ab-cdef-0123-456789abcdef',instances={sales:{cdpPort:19222,vncPort:19322,display:122},overview:{cdpPort:19223,vncPort:19323,display:123}},options={profileRoot,launchRoot,instances};
 const stack=(id,pid)=>[{pid,cmdline:['/app/runtime/chromium/chrome','--user-data-dir='+profileRoot+'/'+id,'--remote-debugging-port='+instances[id].cdpPort],runtimeDirectory:run},{pid:pid+1,cmdline:['/app/runtime/sysroot/usr/bin/Xvfb',':'+instances[id].display],runtimeDirectory:run},{pid:pid+2,cmdline:['/app/runtime/sysroot/usr/bin/x11vnc','-display',':'+instances[id].display,'-rfbport',String(instances[id].vncPort)],runtimeDirectory:run}];
 const sales=stack('sales',100),overview=stack('overview',200);assert.deepEqual(verifySharedBrowserProcesses(sales,options),{chromium:[100],xvfb:[101],vnc:[102]});
 for(const extra of [overview,[overview[0]],[overview[1]],[overview[2]]])assert.throws(()=>verifySharedBrowserProcesses([...sales,...extra],options),/one|physical|shared|instance|owned|Chromium|Xvfb|x11vnc/);
 const unexpected=[{...overview[0],cmdline:[overview[0].cmdline[0],'--user-data-dir='+profileRoot+'/unknown-profile','--remote-debugging-port=29999']},{...overview[1],cmdline:[overview[1].cmdline[0],':777']},{...overview[2],cmdline:[overview[2].cmdline[0],'-display',':777','-rfbport','29999']}];
 for(const extra of unexpected)assert.throws(()=>verifySharedBrowserProcesses([...sales,extra],options),/one physical owned/);
 const foreign={pid:999,cmdline:[sales[0].cmdline[0],'--user-data-dir=/fixture/data','--remote-debugging-port=29999'],runtimeDirectory:'/foreign/runtime'},renderer={...sales[0],pid:998,cmdline:[...sales[0].cmdline,'--type=renderer']};
 assert.deepEqual(verifySharedBrowserProcesses([...sales,foreign,renderer],options),{chromium:[100],xvfb:[101],vnc:[102]});
 for(const mutate of [rows=>{rows[0].cmdline[2]='--remote-debugging-port=19223';},rows=>{rows[1].runtimeDirectory=launchRoot+'/11111111-1111-1111-1111-111111111111';},rows=>{rows[2].cmdline[4]='19323';}]){const rows=structuredClone(sales);mutate(rows);assert.throws(()=>verifySharedBrowserProcesses(rows,options));}
});
test('smoke accepts actual Chromium156 namespace status and rejects missing protection',async()=>{
 const {verifySandboxResult}=await import('../deploy/fnos/smoke-checks.mjs');
 assert.equal(verifySandboxResult(raw(current)).namespace,true);
 for(const body of [current.replace('Layer 1 Sandbox\tNamespace','Layer 1 Sandbox\tSetuid'),current.replace('PID namespaces\tYes','PID namespaces\tNo'),current.replace('Network namespaces\tYes','Network namespaces\tNo'),current.replace('Seccomp-BPF sandbox\tYes','Seccomp-BPF sandbox\tNo')])assert.throws(()=>verifySandboxResult(raw(body)),/sandbox/);
 assert.throws(()=>verifySandboxResult('### Ran Playwright code\n'+current),/result/);
});

test('runtime library audit allows payload or explicit host glibc, rejects host C++ and third-party NSS',async()=>{
 const {isAllowedRuntimeLibrary}=await import('../deploy/fnos/smoke-checks.mjs');
 const runtime='/private/app/runtime',release='/private/app/erp';
 for(const file of [runtime+'/sysroot/lib/libpulsecommon-16.1.so',release+'/apps/purchase/node_modules/@img/sharp-libvips/lib/libvips.so', '/usr/lib/x86_64-linux-gnu/libc.so.6','/lib/x86_64-linux-gnu/libm.so.6','/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib64/ld-linux-x86-64.so.2','/usr/lib/x86_64-linux-gnu/gconv/UTF-32.so'])assert.equal(isAllowedRuntimeLibrary(file,runtime,release),true,file);
 for(const file of ['/usr/lib/x86_64-linux-gnu/libgcc_s.so.1','/usr/lib/x86_64-linux-gnu/libstdc++.so.6','/usr/lib/x86_64-linux-gnu/libnss_systemd.so.2','/usr/lib/x86_64-linux-gnu/libnss_mymachines.so.2','/usr/lib/x86_64-linux-gnu/libnss_mdns4_minimal.so.2','/usr/lib/x86_64-linux-gnu/gio/modules/libdconfsettings.so','/usr/lib/x86_64-linux-gnu/libvulkan_intel.so','/usr/lib/x86_64-linux-gnu/libvulkan_radeon.so','/usr/lib/x86_64-linux-gnu/libvulkan.so.1.3.239','/usr/lib/x86_64-linux-gnu/libva.so.2.1700.0','/usr/lib/x86_64-linux-gnu/libva-drm.so.2.1700.0','/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-252.so','/usr/lib/x86_64-linux-gnu/pulseaudio/libpulsecommon-16.1.so','/tmp/libc.so.6',runtime+'-other/libgood.so'])assert.equal(isAllowedRuntimeLibrary(file,runtime,release),false,file);
});

test('diagnostic cancel file aborts once and synchronously blocks later start checkpoints',{timeout:3000},async t=>{
 const {diagnosticCancellation}=await import('../deploy/fnos/smoke-checks.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-cancel-')),file=path.join(dir,'cancel-request');let requested=0,resolve;
 const event=new Promise(r=>{resolve=r;});const cancellation=diagnosticCancellation(file,()=>{requested++;resolve();});t.after(()=>{cancellation.close();fs.rmSync(dir,{recursive:true,force:true});});
 cancellation.check();fs.writeFileSync(file,'stop');await event;assert.equal(requested,1);assert.throws(()=>cancellation.check(),/cancel/i);fs.appendFileSync(file,'stop-again');assert.throws(()=>cancellation.check(),/cancel/i);assert.equal(requested,1);
});

test('a stop request predating smoke setup prevents its first start',async t=>{
 const {diagnosticCancellation}=await import('../deploy/fnos/smoke-checks.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-cancel-existing-')),file=path.join(dir,'cancel-request');fs.writeFileSync(file,'stop');let requested=0;
 const cancellation=diagnosticCancellation(file,()=>{requested++;});t.after(()=>{cancellation.close();fs.rmSync(dir,{recursive:true,force:true});});assert.equal(requested,1);assert.throws(()=>cancellation.check(),/cancel/i);
});
