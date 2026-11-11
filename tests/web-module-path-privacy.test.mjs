import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
for(const module of ['purchase','sales','overview'])for(const prefix of ['','/app/wuchengerp','/app/wuchengerptrial'])test(module+' '+(prefix||'root')+' redacts known POSIX/Windows host paths while preserving signed business URLs',async t=>{
 const {installWorkbenchModule}=await import(`../apps/${module}/lib/workbench-module.mjs`),{signWorkbenchActor}=await import(`../apps/${module}/lib/workbench-actor.mjs`);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'private-module-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let middleware;const object=()=>Object.fromEntries(['get','post','put','patch','delete','head','options'].map(k=>[k,()=>{}]));const app={...object(),use(fn){middleware=fn;}},router=object();
 const privateSource='/vol4/secret-ledger/source/sales.sqlite';
 const service=installWorkbenchModule(app,router,{module,dataDir:dir,root:dir,state:{},privatePaths:[privateSource]});
 const now=Date.now(),actor={v:1,id:'fnos:nas:1000',login:'user',role:'admin',modules:[module],module,canRunTasks:false,channel:'ui',sessionId:'one',requestId:'request',issuedAt:now,expiresAt:now+30000,method:'GET',path:'/',publicPrefix:prefix};
 let result;const q={headers:{host:'127.0.0.1:1234',...signWorkbenchActor(actor,service.key)},socket:{remoteAddress:'127.0.0.1'},method:'GET',originalUrl:'/',path:'/'};
 const r={set(){},json(v){result=v;},sendFile(){},status(){return this;}};
 middleware(q,r,()=>r.json({path:privateSource,nested:{path:path.join(dir,'private.sqlite')},windows:{path:'C:\\private\\sales.sqlite'},unc:{path:'\\\\nas\\secret\\sales.sqlite'},errors:[{message:'源账本不存在：'+privateSource}],hostError:'read '+path.join(dir,'missing.db'),asset:'/asset.png',api:'/api/items',cross:'/apps/sales/',web:'/web/help',businessURL:'https://shop.example.com/products/foo',relative:'images/product.png',sources:{sales:{path:privateSource,url:'http://127.0.0.1:17870'}}}));
 assert.equal(result.path,'');assert.equal(result.nested.path,'');assert.equal(result.windows.path,'');assert.equal(result.unc.path,'');
 assert(!JSON.stringify(result).includes(privateSource));assert(!JSON.stringify(result).includes(dir));
 assert.equal(result.asset,`${prefix}/apps/${module}/asset.png`);assert.equal(result.api,`${prefix}/apps/${module}/api/items`);assert.equal(result.cross,prefix+'/apps/sales/');assert.equal(result.web,prefix+'/web/help');assert.equal(result.businessURL,'https://shop.example.com/products/foo');assert.equal(result.relative,'images/product.png');
});
