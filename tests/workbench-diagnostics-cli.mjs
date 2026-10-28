import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-diagnostic-cli-'));
const registry=path.join(root,'registry.json');
fs.writeFileSync(registry,JSON.stringify(Object.fromEntries(['warehouse','purchase','sales','overview','exporter'].map((id,index)=>[id,{managed:true,root:path.join(root,id),dataDir:path.join(root,'data',id),port:19620+index,exe:path.join(root,id,'missing.exe')}]))));
const logs=path.join(root,'launcher/logs');fs.mkdirSync(logs,{recursive:true});fs.writeFileSync(path.join(logs,'workbench.log'),'[2026-01-01 00:00:00] [error] [workbench] FIRST-RUN-DIAGNOSTIC password="hidden phrase"\n');
const env={...process.env,LINGTU_REGISTRY_PATH:registry,LINGTU_ISOLATED_TEST:'1',LINGTU_SKIP_BUNDLED_ACTIVATION:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.LINGTU_SUITE_DIRECTORY;
function run(command){const result=spawnSync(path.resolve(process.env.LAUNCHER_TEST_EXE||'node_modules/electron/dist/electron.exe'),[...(process.env.LAUNCHER_TEST_EXE?[]:[path.resolve('desktop/launcher')]),'--user-data-dir='+root,'--registry-file='+registry,'--cli',command],{env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});assert.equal(result.status,0,result.stdout+result.stderr);return JSON.parse(result.stdout);}
const found=run('debug-logs');assert.ok(found.lines.some(line=>line.includes('FIRST-RUN-DIAGNOSTIC')));assert.ok(!JSON.stringify(found).includes('hidden phrase'));
const bundle=run('debug-bundle');assert.equal(bundle.bundle.format,'lingtu-diagnostics/v1');assert.equal(bundle.sha256.length,64);assert.ok(bundle.path.startsWith(logs));assert.equal(fs.statSync(bundle.path).size,bundle.size);assert.ok(!JSON.stringify(bundle.bundle).includes('hidden phrase'));
assert.equal(fs.existsSync(path.join(root,'data')),false,'Diagnostic access must not create a business data directory');
console.log(JSON.stringify({ok:true,firstRunWithoutBusinessModules:true,logsReadable:true,legacyBundleFieldsPreserved:true,noBusinessDataCreated:true}));
