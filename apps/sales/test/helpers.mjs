import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {openStore as openRealStore} from '../lib/db.mjs';
import {createApp as createRealApp} from '../server.mjs';

export const TEST_SHOPS=Object.freeze([
  {id:'tb-diankou',platform:'淘宝',name:'隔离测试淘宝甲'},
  {id:'tb-xishi',platform:'淘宝',name:'隔离测试淘宝乙'},
  {id:'pdd-mipeijiang',platform:'拼多多',name:'隔离测试拼多多'},
  {id:'ozon',platform:'Ozon',name:'隔离测试Ozon'}
]);
const assertTemporary=dir=>assert.ok(typeof dir==='string'&&path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep),'Test shops may only be registered in an isolated temporary ledger');
function seed(store){
  assertTemporary(store.dir);
  for(const shop of TEST_SHOPS)store.run('INSERT OR IGNORE INTO shops VALUES(?,?,?,?,?)',shop.id,shop.platform,shop.name,'合成测试来源',0);
  return store;
}
export function openStore(dir){assertTemporary(dir);return seed(openRealStore(dir));}
export function createApp(options){assertTemporary(options?.dataDir);const result=createRealApp(options);seed(result.store);return result;}

// Explicit HTTP fixture login; production apps never default to an owner role.
export async function createSessionFetch(base,role){
 const cookies=new Map();
 const request=async(input,options={})=>{
  const headers=new Headers(options.headers||{});
  for(const part of String(headers.get('cookie')||'').split(';')){const at=part.indexOf('=');if(at>0)cookies.set(part.slice(0,at).trim(),part.slice(at+1).trim());}
  if(cookies.size)headers.set('Cookie',[...cookies].map(([key,value])=>key+'='+value).join('; '));
  const response=await globalThis.fetch(input,{...options,headers});
  for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],at=pair.indexOf('=');if(at>0)cookies.set(pair.slice(0,at),pair.slice(at+1));}
  return response;
 };
 const bootstrap=await(await request(base+'/api/bootstrap')).json();
 const selected=await request(base+'/api/personnel/session',{method:'POST',headers:{'Content-Type':'application/json','x-sales-token':bootstrap.token},body:JSON.stringify({role})});
 assert.equal(selected.status,200,await selected.clone().text());
 return request;
}
