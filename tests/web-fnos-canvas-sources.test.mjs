import test from 'node:test';
import assert from 'node:assert/strict';
const mpl=['cssparser','cssparser-color','cssparser-macros','dtoa-short'];
const crate=(name,license='MIT')=>({name,version:'1.0.0',purl:'pkg:cargo/'+name+'@1.0.0',licenses:[{expression:license}],hashes:[{alg:'SHA-256',content:'a'.repeat(64)}]});
test('Canvas source policy requires exact MPL coverage and rejects new copyleft silently entering native payload',async()=>{
 const {canvasSourcePolicy}=await import('../deploy/fnos/canvas-source-policy.mjs');
 const components=mpl.map(n=>crate(n,'MPL-2.0')).concat(crate('napi','MIT OR Apache-2.0'));
 assert.deepEqual(canvasSourcePolicy({components}).correspondingSource.map(c=>c.name),mpl);
 assert.throws(()=>canvasSourcePolicy({components:components.slice(1)}),/MPL/);
 assert.throws(()=>canvasSourcePolicy({components:[...components,crate('new-code','LGPL-2.1-only')]}),/review/i);
 assert.throws(()=>canvasSourcePolicy({components:[...components,crate('unknown','')]}),/license/i);
 assert.throws(()=>canvasSourcePolicy({components:components.map(c=>({...c,hashes:[]}))}),/checksum/i);
});
