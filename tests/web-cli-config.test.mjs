import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {developmentConfig,databases} from '../server/config.mjs';
import {resolveCommandConfig} from '../server/cli.mjs';

test('dev honors an explicit isolated source configuration',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-dev-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const expected=developmentConfig({root:dir,stateDir:path.join(dir,'isolated'),port:29430}),file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(expected));
 assert.deepEqual(resolveCommandConfig('dev',file),expected);
});
test('dev refuses a production configuration before starting services',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-dev-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const c=developmentConfig({root:dir,stateDir:path.join(dir,'isolated'),port:29430});c.mode='production';c.publicOrigin='https://erp.example.test';c.releaseRoot=dir;
 for(const [id,m] of Object.entries(c.modules)){fs.mkdirSync(m.dataDir,{recursive:true});fs.writeFileSync(path.join(m.dataDir,databases[id]),'isolated sentinel');}
 const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(c));assert.throws(()=>resolveCommandConfig('dev',file),/开发.*隔离/);
});
