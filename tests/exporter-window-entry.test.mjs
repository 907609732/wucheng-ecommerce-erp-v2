import test from 'node:test';
import assert from 'node:assert/strict';
import {createActions,EXPORTER_SHOW_API_VERSION} from '../desktop/extensions/lingtu-desks/extension.mjs';

test('independent exporter entry reuses the service and explicitly restores its window',async()=>{
  const events=[],cap={running:true};
  const actions=createActions({ensure:async id=>{events.push(['ensure',id]);return cap;},request:async(...args)=>{events.push(['request',...args]);return {opened:true};}});
  assert.equal(EXPORTER_SHOW_API_VERSION,1);
  assert.equal(await actions.start({desk:'exporter'}),cap);
  assert.deepEqual(events,[['ensure','exporter']]);events.length=0;
  assert.deepEqual(await actions.start({desk:'exporter',show:true}),{opened:true});
  assert.deepEqual(events,[['ensure','exporter'],['request','exporter','/open',{method:'POST',body:{confirm:true}}]]);
  events.length=0;
  await assert.rejects(actions.start({desk:'purchase',show:true}));
  await assert.rejects(actions.start({desk:'exporter',show:'true'}));
  assert.deepEqual(events,[]);
});
