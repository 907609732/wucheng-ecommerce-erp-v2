import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createOwnedTarget,closeOwnedTarget,ownedOperationCode} from '../server/collector-owned-page.mjs';

test('real Chromium: module targets share login storage, ignore fallback tab, and close independently',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shared-browser-runtime-'));
 const context=await chromium.launchPersistentContext(dir,{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
 try {
  await context.route('https://shared-browser-fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>isolated shared browser fixture</title>'}));
  const endpoint='http://127.0.0.1:'+fs.readFileSync(path.join(dir,'DevToolsActivePort'),'utf8').split('\n')[0];
  const fallback=context.pages()[0],a=await createOwnedTarget(endpoint),b=await createOwnedTarget(endpoint);
  const invoke=(operation,args,target)=> (0,eval)('('+ownedOperationCode(operation,args,target.targetId)+')')(fallback);
  await invoke(async(page)=>{await page.goto('https://shared-browser-fixture.invalid/');await page.evaluate(()=>{document.cookie='login=fixture; Path=/';localStorage.setItem('shared-login','fixture');});return page.url();},{},a);
  const read=await invoke(async(page)=>{await page.goto('https://shared-browser-fixture.invalid/');return page.evaluate(()=>({cookie:document.cookie,login:localStorage.getItem('shared-login')}));},{},b);
  assert.match(read.cookie,/login=fixture/);assert.equal(read.login,'fixture');assert.equal(fallback.url(),'about:blank');
  await closeOwnedTarget(a);
  await assert.rejects(invoke(async()=>true,{},a),/BROWSER_PAGE_CLOSED/);
  assert.equal(await invoke(async(page)=>page.title(),{},b),'isolated shared browser fixture');
  await closeOwnedTarget(b);assert.equal(fallback.isClosed(),false);
  // A second CDP observer matches the MCP topology: target creation happens
  // through another websocket, followed immediately by execution without an
  // artificial sleep or waitForEvent('page') registration barrier.
  const observer=await chromium.connectOverCDP(endpoint);
  try {
   const observerFallback=observer.contexts()[0].pages()[0];
   for(let iteration=0;iteration<12;iteration++){
    const target=await createOwnedTarget(endpoint);
    const operation=async page=>{const session=await page.context().newCDPSession(page);try{return (await session.send('Target.getTargetInfo')).targetInfo.targetId;}finally{await session.detach();}};
    const actual=await (0,eval)('('+ownedOperationCode(operation,{},target.targetId)+')')(observerFallback);
    assert.equal(actual,target.targetId);await closeOwnedTarget(target);
   }
   assert.equal(observerFallback.isClosed(),false);assert.equal(observerFallback.url(),'about:blank');
  }finally{await observer.close();}
 }finally{await context.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
