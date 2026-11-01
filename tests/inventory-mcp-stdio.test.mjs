import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('stdio MCP exposes only the inventory tools and keeps side effects gated',{timeout:15000},async()=>{
  const packaged=process.env.MCP_TEST_EXE;
  const profile=packaged?fs.mkdtempSync(path.join(os.tmpdir(),'inventory-mcp-packaged-')):null;
  const child=spawn(packaged||process.execPath,packaged?['--mcp-stdio','--user-data-dir='+profile]:['desktop/mcp-stdio-entry.mjs'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,LINGTU_SKIP_BUNDLED_ACTIVATION:'1',LINGTU_ISOLATED_TEST:'1'}});
  const pending=new Map();let buffer='',stderr='',nextId=0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    for(let index;(index=buffer.indexOf('\n'))>=0;){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      if(!line.trim())continue;
      const message=JSON.parse(line),entry=pending.get(message.id);
      if(entry){pending.delete(message.id);entry.resolve(message);}
    }
  });
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  const request=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP timeout: '+method+' '+stderr.slice(-500)));},10000);
    pending.set(id,{resolve:message=>{clearTimeout(timer);resolve(message);}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  try{
    const initialized=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'inventory-smoke',version:'1.0.0'}});
    assert.ok(initialized.result,JSON.stringify(initialized.error||stderr));
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const listed=await request('tools/list');
    assert.ok(listed.result,JSON.stringify(listed.error||stderr));
    const names=listed.result.tools.map(tool=>tool.name).sort();
    assert.deepEqual(names,['cainiao_refresh_login','inventory_debug_diagnose','inventory_debug_export_bundle','inventory_debug_search_logs','inventory_extension_call','inventory_extension_list','inventory_recent_logs','inventory_runtime_capabilities','inventory_status','inventory_sync_once']);
    if(packaged){
      for(const name of ['inventory_status','inventory_runtime_capabilities']){
        const response=await request('tools/call',{name,arguments:{}});
        assert.equal(response.result?.isError,undefined,JSON.stringify(response.error||stderr));
        assert.ok(JSON.parse(response.result.content.find(item=>item.type==='text').text));
      }
    }
    for(const [name,args] of [['inventory_sync_once',{confirmSend:false}],['cainiao_refresh_login',{confirmOpenBrowser:false}]]){
      const response=await request('tools/call',{name,arguments:args});
      assert.equal(response.result?.isError,true,JSON.stringify(response.error||stderr));
    }
  }finally{
    child.stdin.end();
    await Promise.race([once(child,'close'),new Promise(resolve=>setTimeout(()=>{child.kill();resolve();},1000))]);
    if(profile)fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
