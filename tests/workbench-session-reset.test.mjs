import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../desktop/launcher/main.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function resetPrivateConnection(){'),source.indexOf('function guardPrivateSession('));
function fixture(){const client={},purchase={},sales={},calls=[];const globals={clientSession:client,privateSessionWrites:new Map([[client,new Set()],[purchase,new Set()],[sales,new Set()]]),activeNetworkRequests:0,desks:{reset:()=>calls.push('views-reset')},forgetDirectTailnetSession:s=>calls.push(['forget',s]),resetEmbeddedSession:async s=>calls.push(['reset',s]),transport:{live:true},remoteManager:{live:true}};vm.createContext(globals);return {client,purchase,sales,calls,globals,reset:()=>vm.runInContext(body+'resetPrivateConnection()',globals)}}
test('connection switch resets every registered private session exactly once and releases transport',async()=>{const f=fixture();await f.reset();assert.equal(f.calls[0],'views-reset');assert.deepEqual(f.calls.filter(c=>c[0]==='reset').map(c=>c[1]),[f.client,f.purchase,f.sales]);assert.equal(f.globals.transport,null);assert.equal(f.globals.remoteManager,null);});
test('in-flight writes and network requests block reset before destroying any view',async()=>{for(const kind of ['write','network']){const f=fixture();if(kind==='write')f.globals.privateSessionWrites.get(f.purchase).add('write');else f.globals.activeNetworkRequests=1;await assert.rejects(f.reset(),/请求尚未结束/);assert.deepEqual(f.calls,[]);assert.equal(f.globals.transport.live,true);}});
