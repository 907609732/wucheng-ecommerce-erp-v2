import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserLaunchOptions,launchSystemBrowser} from '../core/browser-launch.js';

test('automatic login prefers system Edge', () => {
  assert.deepEqual(browserLaunchOptions(), {channel:'msedge'});
});
test('browser launch falls back to Chrome when Edge cannot launch', async () => {
  const calls=[];
  const chromium={launch:async options=>{calls.push(options);if(options.channel==='msedge')throw Error('Edge unavailable');return 'chrome-browser';}};
  assert.equal(await launchSystemBrowser(chromium,'launch',[{headless:false}]),'chrome-browser');
  assert.deepEqual(calls,[{headless:false,channel:'msedge'},{headless:false,channel:'chrome'}]);
});
test('persistent login keeps its profile and options when falling back', async () => {
  const calls=[];
  const chromium={launchPersistentContext:async (profile,options)=>{calls.push({profile,options});if(options.channel==='msedge')throw Error('Edge unavailable');return 'chrome-context';}};
  assert.equal(await launchSystemBrowser(chromium,'launchPersistentContext',['profile',{viewport:{width:1440}}]),'chrome-context');
  assert.deepEqual(calls.map(call=>call.options.channel),['msedge','chrome']);
  assert(calls.every(call=>call.profile==='profile'&&call.options.viewport.width===1440));
});
