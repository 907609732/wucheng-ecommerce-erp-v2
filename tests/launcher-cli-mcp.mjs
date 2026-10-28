import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-launcher-cli-'));
const registry=path.join(root,'registry.json');
fs.writeFileSync(registry,JSON.stringify(Object.fromEntries(['purchase','sales','overview','exporter'].map(id=>[id,{managed:true,root:path.join(root,id),dataDir:path.join(root,'data',id),exe:path.join(root,id,'missing.exe')}]))));
const exe=path.resolve(process.env.LAUNCHER_TEST_EXE||'dist/launcher-release/win-unpacked/云仓库存同步.exe');
const env={...process.env,LINGTU_REGISTRY_PATH:registry};delete env.ELECTRON_RUN_AS_NODE;
const cli=args=>{
  const result=spawnSync(exe,[...args,'--user-data-dir='+root],{env,encoding:'utf8',windowsHide:true,timeout:30000});
  return {status:result.status,data:JSON.parse(result.stdout.trim())};
};
const status=cli(['--cli','status']);assert.equal(status.status,0);assert.equal(status.data.ok,true);
const missing=cli(['--cli','extension-call','--id=lingtu.desks','--action=query','--params-json={"desk":"purchase","kind":"orders"}']);
assert.equal(missing.status,1);assert.ok(['MODULE_NOT_INSTALLED','SUITE_SETUP_REQUIRED'].includes(missing.data.code));
const transport=new StdioClientTransport({command:exe,args:['--mcp-stdio','--user-data-dir='+root],env,stderr:'pipe'});
const client=new Client({name:'isolated-launcher-check',version:'1.0.0'});
try{
  await client.connect(transport);
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='inventory_extension_call'));
  const result=await client.callTool({name:'inventory_extension_list',arguments:{}});
  assert.ok(!result.isError);
  assert.ok(JSON.parse(result.content.find(c=>c.type==='text').text).extensions.some(e=>e.id==='lingtu.desks'));
}finally{await client.close();}
console.log(JSON.stringify({ok:true,cli:true,mcp:true,missingModuleDoesNotInstall:true}));
