import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const shell=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/sh';
for(const mode of ['off','verify','failure','invalid'])test('official config callback exclusive UVCS branch: '+mode,{skip:!fs.existsSync(shell)},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uvcs-hook-')).replaceAll('\\','/');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.copyFileSync(new URL('../deploy/fnos/wuchengerp/cmd/config_callback',import.meta.url),path.join(root,'config_callback'));
 const trace=root+'/trace',config=root+'/web.json';fs.writeFileSync(config,'unchanged config');
 fs.writeFileSync(path.join(root,'native_env'),`PAYLOAD='${root}/payload'\nCONFIG='${config}'\nNODE='${process.execPath}'\nLIFECYCLE='${root}/lifecycle.mjs'\nprepare() { echo prepare >> '${trace}'; }\nprovision_uvcs() { echo provision >> '${trace}'; }\nas_package() { printf '%s\\n' "$*" >> '${trace}'; return ${mode==='failure'?7:0}; }\nfail() { exit 1; }\n`);
 const env={...process.env};delete env.wizard_uvcs_verify;if(mode!=='off')env.wizard_uvcs_verify=mode==='invalid'?'malformed':'1';
 const r=spawnSync(shell,[path.join(root,'config_callback')],{env,encoding:'utf8'}),output=fs.existsSync(trace)?fs.readFileSync(trace,'utf8'):'';
 assert.equal(fs.readFileSync(config,'utf8'),'unchanged config');
 if(mode==='off'){assert.equal(r.status,0);assert.match(output,/prepare\nprovision\n/);assert.match(output,/lifecycle.mjs configure/);assert.equal(output.includes('verify-uvcs.mjs'),false);}
 else if(mode==='invalid'){assert.notEqual(r.status,0);assert.equal(output,'');}
 else{assert.equal(r.status,mode==='failure'?1:0);assert.equal(output.includes('prepare'),false);assert.equal(output.includes('provision'),false);assert.equal(output.includes('lifecycle.mjs configure'),false);assert.match(output,/payload\/erp\/server\/fnos-native\/verify-uvcs.mjs --config/);}
});
