import test from 'node:test';
import assert from 'node:assert/strict';
const raw=body=>'### Result\n'+JSON.stringify(body)+'\n### Ran Playwright code\n```js\nawait page.evaluate(...);\n```';
const current='Sandbox Status\nLayer 1 Sandbox\tNamespace\nPID namespaces\tYes\nNetwork namespaces\tYes\nSeccomp-BPF sandbox\tYes\nYou are adequately sandboxed.';
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
 for(const file of ['/usr/lib/x86_64-linux-gnu/libgcc_s.so.1','/usr/lib/x86_64-linux-gnu/libstdc++.so.6','/usr/lib/x86_64-linux-gnu/libnss_systemd.so.2','/usr/lib/x86_64-linux-gnu/pulseaudio/libpulsecommon-16.1.so','/tmp/libc.so.6',runtime+'-other/libgood.so'])assert.equal(isAllowedRuntimeLibrary(file,runtime,release),false,file);
});
