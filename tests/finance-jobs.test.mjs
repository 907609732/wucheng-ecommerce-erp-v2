import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { financeJob } from '../desktop/shared/finance-jobs.mjs';

test('concurrent worker requests serialize per ledger and recover after a failed operation', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'finance-worker-queue-'));
  const shop=await financeJob(directory,'saveShop',{name:'并发测试店铺'});
  const results=await Promise.allSettled([
    ...Array.from({length:8},(_,i)=>financeJob(directory,'newJob',shop.id,`2026-${String(i+1).padStart(2,'0')}`)),
    financeJob(directory,'unknown'),financeJob(directory,'report',shop.id,'2026-09')
  ]);
  assert.ok(results.slice(0,8).every(result=>result.status==='fulfilled'));
  assert.equal(results[8].status,'rejected');
  assert.equal(results[9].status,'fulfilled');
  assert.equal(results[9].value.jobs.length,8);
});
