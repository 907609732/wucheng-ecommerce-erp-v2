import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const exe=path.join(process.env.LOCALAPPDATA,'Programs','wucheng-ecommerce-erp-v2','云仓库存同步.exe');
const userData=fs.mkdtempSync(path.join(os.tmpdir(),'installed-desk-mcp-'));
const parse=r=>{assert.equal(r.isError,undefined,r.content?.find(c=>c.type==='text')?.text);return JSON.parse(r.content.find(c=>c.type==='text').text);};
const cli=spawnSync(exe,['--cli','extension-call','--id=lingtu.desks','--action=status','--user-data-dir='+userData],{encoding:'utf8',windowsHide:true,timeout:30000});
assert.equal(cli.status,0,cli.stderr);const cliData=JSON.parse(cli.stdout);assert.equal(cliData.ok,true);
const transport=new StdioClientTransport({command:exe,args:['--mcp-stdio','--user-data-dir='+userData],stderr:'pipe'}),client=new Client({name:'installed-desks-acceptance',version:'1.0.0'});
try{
 await client.connect(transport);
 const discovered=parse(await client.callTool({name:'inventory_extension_list',arguments:{}}));
 assert.equal(discovered.extensions.find(x=>x.id==='lingtu.desks').trusted,true);
 const query=async(desk,kind,query={})=>parse(await client.callTool({name:'inventory_extension_call',arguments:{extensionId:'lingtu.desks',action:'query',params:{desk,kind,query},confirmSideEffect:false}})).result;
 const purchases=await query('purchase','orders'),tasks=await query('exporter','tasks');
 assert.equal(purchases.orders.length,472);assert.equal(tasks.tasks.length,4);
 const manager=new ServiceManager(),services=await manager.status();
 for(const id of ['purchase','sales','overview'])assert.equal(services.find(s=>s.extension===id).status,'running');
 const transfers=await manager.request('purchase','/transfers'),batch=transfers.batches[0];
 assert.equal(batch.state,'draft');const draft=await manager.request('purchase','/transfers/'+batch.id);assert.equal(draft.canConfirm,false);assert.equal(draft.rows.length,3);
 const report={ok:true,installedHost:'0.7.0',installedExporter:'0.2.0',purchaseCount:purchases.orders.length,exporterTasks:tasks.tasks.length,realSample:{orders:3,canConfirm:false,state:'draft',errors:draft.errors,missingRefund:draft.rows.filter(r=>r.refundUnknown).length},services:services.map(({extension,version,status,dataDir})=>({extension,version,status,dataDir})),cli:true,mcp:true,checkedAt:new Date().toISOString()};
 fs.writeFileSync('dist/integration-verification/installed-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await client.close();}
