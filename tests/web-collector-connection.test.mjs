import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorConnection} from '../server/collector-browser-connection.mjs';

test('Linux MCP child preserves the trusted private loader path without copying unrelated credentials',async()=>{
 const {collectorChildEnvironment}=await import('../server/collector-browser-connection.mjs');
 const env={LD_LIBRARY_PATH:'/private/runtime/sysroot/lib/x86_64-linux-gnu',SECRET:'do-not-forward',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'windows-only'};
 assert.deepEqual(collectorChildEnvironment({platform:'linux',env}),{LD_LIBRARY_PATH:env.LD_LIBRARY_PATH});
 assert.deepEqual(collectorChildEnvironment({platform:'linux',env:{}}),{});
 assert.deepEqual(collectorChildEnvironment({platform:'win32',env}),{});
});

test('Windows collector retains the consented Chrome extension connection', () => {
  const result=collectorConnection('sales',{platform:'win32',env:{}});
  assert.deepEqual(result.args,['--extension']);
  assert.equal(result.usesExtension,true);
});

test('Linux collector accepts only loopback CDP endpoints, separately per module', () => {
  const env={LINGTU_SALES_CDP_ENDPOINT:'http://127.0.0.1:19222',LINGTU_OVERVIEW_CDP_ENDPOINT:'http://127.0.0.1:19223'};
  assert.deepEqual(collectorConnection('sales',{platform:'linux',env}).args,['--cdp-endpoint','http://127.0.0.1:19222']);
  assert.deepEqual(collectorConnection('overview',{platform:'linux',env}).args,['--cdp-endpoint','http://127.0.0.1:19223']);
  assert.throws(()=>collectorConnection('sales',{platform:'linux',env:{LINGTU_SALES_CDP_ENDPOINT:'http://192.168.1.100:9222'}}),/本机/);
  assert.throws(()=>collectorConnection('sales',{platform:'linux',env:{}}),/尚未配置/);
});
