import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {targets,assetNames} from '../scripts/sync-ui-assets.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('shared UI distributes only to the three browser business desks',()=>{
 assert.deepEqual(targets,['apps/purchase/public/ui','apps/sales/public/ui','apps/overview/public/ui']);
 for(const target of targets) for(const name of assetNames()) assert.deepEqual(fs.readFileSync(path.join(root,target,name)),fs.readFileSync(path.join(root,'ui',name)),target+'/'+name);
});
test('browser pages load shared tokens and period controllers without restoring native launch bridges',()=>{
 for(const id of ['purchase','sales','overview']){
  const html=fs.readFileSync(path.join(root,'apps',id,'public/index.html'),'utf8');
  for(const name of ['tokens.css','base.css','components.css']) assert.ok(html.includes('ui/'+name),id+'/'+name);
  assert.match(fs.readFileSync(path.join(root,'apps',id,'public/app.js'),'utf8'),/ui\/period-picker\.mjs/);
 }
 const review=fs.readFileSync(path.join(root,'apps/purchase/public/integration-review.js'),'utf8');
 assert.doesNotMatch(review,/lingtuShell|exporter\/open/);
 assert.doesNotMatch(fs.readFileSync(path.join(root,'apps/purchase/public/integration-review.html'),'utf8'),/id="launch"/);
});

test('browser navigation shares the same palette as its three business desks',()=>{
 assert.deepEqual(fs.readFileSync(path.join(root,'server/public/tokens.css')),fs.readFileSync(path.join(root,'ui/tokens.css')));
 assert.match(fs.readFileSync(path.join(root,'server/public/index.html'),'utf8'),/\/web\/tokens\.css/);
 assert.match(fs.readFileSync(path.join(root,'server/public/shell.css'),'utf8'),/var\(--lt-brand/);
});
