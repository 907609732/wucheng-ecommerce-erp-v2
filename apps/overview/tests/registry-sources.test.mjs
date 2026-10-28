import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPaths,loadSources} from '../lib/sources.mjs';
test('source paths follow later module installations without restarting overview',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'overview-registry-')),file=path.join(root,'registry.json');
 const previous=process.env.LINGTU_REGISTRY_PATH;
 process.env.LINGTU_REGISTRY_PATH=file;
 try{
  fs.writeFileSync(file,JSON.stringify({purchase:{dataDir:path.join(root,'first')}}));
  assert.equal(defaultPaths.purchase,path.join(root,'first','purchases.sqlite'));
  fs.writeFileSync(file,JSON.stringify({purchase:{dataDir:path.join(root,'later')},sales:{dataDir:path.join(root,'sales')}}));
  assert.equal(defaultPaths.purchase,path.join(root,'later','purchases.sqlite'));
  const sources=loadSources();assert.equal(sources.paths.sales,path.join(root,'sales','sales.sqlite'));
  assert.equal(sources.errors.length,2);
 }finally{
  if(previous===undefined)delete process.env.LINGTU_REGISTRY_PATH;else process.env.LINGTU_REGISTRY_PATH=previous;
 }
});
