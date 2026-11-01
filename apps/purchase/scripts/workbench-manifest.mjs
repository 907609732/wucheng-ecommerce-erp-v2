import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
process.env.LINGTU_WORKBENCH_MANIFEST_BUILD='1';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-manifest-'));
const {createApp}=await import('../server.mjs');let instance;
try{
 instance=createApp({dataDir:dir,port:19780,sources:{purchase:path.join(dir,'source-purchase.sqlite'),sales:path.join(dir,'source-sales.sqlite')}});
 const operations=instance.integration.workbench.operations.slice().sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method));
 const file=path.join(root,'workbench-manifest.json'),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({schemaVersion:1,operations},null,2)+'\n');fs.renameSync(temp,file);console.log('Registered operations:',operations.length);
}finally{await instance?.cainiao?.close();instance?.store.close();const resolved=path.resolve(dir),tempRoot=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(tempRoot)||!path.basename(resolved).startsWith('workbench-manifest-'))throw Error('拒绝清理无效临时目录');fs.rmSync(resolved,{recursive:true,force:true});}
