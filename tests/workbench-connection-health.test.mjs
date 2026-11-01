import test from 'node:test';
import assert from 'node:assert/strict';
import {serverConnectionHealth,clientConnectionFailure} from '../desktop/workbench-client/connection-health.mjs';

const state={serverUrl:'https://synthetic.example.ts.net:8443'},identity={serverId:'synthetic-server',dataSetId:'synthetic-dataset'};
const healthy={ok:true,service:'wucheng-workbench',protocolVersion:1,...identity};
const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
test('server ready requires both loopback and TLS entry with the original identity, using GET only',async()=>{
  const calls=[];
  const result=await serverConnectionHealth({state,identity,fetchImpl:async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);assert(options.signal);return json(healthy);}});
  assert.equal(result.state,'ready');
  assert.deepEqual(calls,['http://127.0.0.1:17330/api/workbench/v1/health',state.serverUrl+'/api/workbench/v1/health']);
});
test('an unrelated local server or missing ledger identity can never report ready',async()=>{
  for(const [body,expected]of [[{...healthy,serverId:'different'},'主服务器身份不符'],[{...healthy,service:'other-app'},'主服务器未就绪']]){
    let calls=0;const result=await serverConnectionHealth({state,identity,fetchImpl:async()=>{calls++;return json(body);}});
    assert.equal(result.state,'error');assert.equal(result.label,expected);assert.equal(calls,1);
  }
  assert.equal((await serverConnectionHealth({state,fetchImpl:async()=>json(healthy)})).state,'error');
});
test('a healthy local gateway cannot conceal an unreachable, wrong-identity, or invalid TLS entry',async()=>{
  for(const failure of ['offline','certificate','identity','html']){
    const result=await serverConnectionHealth({state,identity,fetchImpl:async url=>{
      if(url.startsWith('http:'))return json(healthy);
      if(failure==='identity')return json({...healthy,dataSetId:'different'});
      if(failure==='html')return new Response('login page',{headers:{'Content-Type':'text/html'}});
      throw Object.assign(Error('untrusted diagnostic must not escape'),{cause:{code:failure==='certificate'?'CERT_HAS_EXPIRED':'ECONNREFUSED'}});
    }});
    assert.equal(result.state,'warning');assert.equal(result.label,'私网入口异常');assert(!JSON.stringify(result).includes('untrusted diagnostic'));
    if(failure==='certificate')assert.match(result.detail,/证书验证失败/);
  }
});
test('client permission and identity errors stay distinct from network loss without exposing session data',()=>{
  assert.equal(clientConnectionFailure({status:403,message:'secret'}).state,'unauthorized');
  assert.equal(clientConnectionFailure({code:'DATASET_CHANGED'}).state,'identity-error');
  assert.equal(clientConnectionFailure({code:'SERVER_UNAVAILABLE'}).state,'offline');
  assert(!JSON.stringify(clientConnectionFailure({message:'csrf-secret'})).includes('csrf-secret'));
});
