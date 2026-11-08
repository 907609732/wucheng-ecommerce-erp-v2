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
