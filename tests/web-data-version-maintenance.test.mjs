import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('offline version migration refuses a running module before opening any ledger',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'version-maintenance-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'.integration-runtime.json'),JSON.stringify({pid:process.pid}));
  const {disableOfflineDataVersioning}=await import('../server/data-version/cli.mjs');
  assert.throws(()=>disableOfflineDataVersioning({modules:{purchase:{dataDir:dir}}}),/停止/);
  assert(!fs.existsSync(path.join(dir,'purchases.sqlite')));
});
