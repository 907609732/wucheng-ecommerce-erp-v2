import {randomUUID} from 'node:crypto';
import {importRules} from '../public/import-rules.mjs';
import {supplierSummary} from './suppliers.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const text=(v,max,label)=>{const s=String(v??'').trim();if(s.length>max)throw fail(label+'过长');return s;};
const array=(v,max,label)=>{if(!Array.isArray(v)||v.length>max)throw fail(label+'格式无效或数量过多');return v;};
const key=(p,s)=>JSON.stringify([p,s]);
export function normalizeSupplier(input){
 const name=text(input.name,200,'供应商名称');if(!name)throw fail('请填写供应商名称');
 const shops=array(input.shops||[],100,'店铺').map(s=>{
  const platform=text(s.platform,30,'平台'),shopName=text(s.name,200,'店铺名称')||name;
  if(!Object.hasOwn(importRules,platform))throw fail('请选择有效店铺平台');
  const url=text(s.url,2000,'店铺网址');if(url){let u;try{u=new URL(url);}catch{throw fail('店铺网址请填写完整的 http / https 地址');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw fail('店铺网址只支持无账号密码的 http / https 地址');}
  return {platform,name:shopName,url,account:text(s.account,200,'采购账号'),note:text(s.note,2000,'店铺备注')};
 });
 if(new Set(shops.map(s=>key(s.platform,s.name))).size!==shops.length)throw fail('同一平台的同名店铺不能重复');
 const addresses=array(input.addresses||[],100,'地址').map(a=>({label:text(a.label,100,'地址标签'),name:text(a.name,200,'联系人'),phone:text(a.phone,40,'联系电话'),address:text(a.address,4000,'地址'),note:text(a.note,2000,'地址备注')}));
 if(addresses.some(a=>!a.address&&!a.name&&!a.phone))throw fail('地址至少填写联系人、电话或详细地址');
 const products=array(input.products||[],500,'产品').map(p=>{
  const name=text(p.name,400,'产品名称');if(!name)throw fail('请填写产品名称');
  const priceCents=p.priceCents==null||p.priceCents===''?null:Number(p.priceCents);if(priceCents!==null&&(!Number.isSafeInteger(priceCents)||priceCents<0||priceCents>1e12))throw fail('参考单价须为有效非负金额');
  return {name,spec:text(p.spec,1000,'产品规格'),sku:text(p.sku,200,'产品编号'),unit:text(p.unit,100,'单位'),priceCents,note:text(p.note,2000,'产品备注')};
 });
 return {name,contact:text(input.contact,200,'联系人'),phone:text(input.phone,40,'联系电话'),wechat:text(input.wechat,200,'微信'),note:text(input.note,10000,'备注'),shops,addresses,products};
}
export function openSupplierManagement(store,addresses){
 const {db}=store;
 db.exec(`CREATE TABLE IF NOT EXISTS supplier_profiles(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS supplier_shop_links(profile_id TEXT NOT NULL REFERENCES supplier_profiles(id),platform TEXT NOT NULL,shop_name TEXT NOT NULL,PRIMARY KEY(platform,shop_name));
 CREATE TABLE IF NOT EXISTS supplier_profile_history(id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL REFERENCES supplier_profiles(id),before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const decode=r=>r&&({...JSON.parse(r.data_json),id:r.id,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at});
 const profiles=()=>db.prepare('SELECT * FROM supplier_profiles ORDER BY updated_at DESC').all().map(decode);
 const get=id=>{const p=decode(db.prepare('SELECT * FROM supplier_profiles WHERE id=?').get(id));if(!p)throw fail('供应商档案不存在',404);return p;};
 const save=(id,input,{reservedId}={})=>store.transaction(()=>{
  if(reservedId&&!/^[a-f0-9-]{36}$/i.test(reservedId))throw fail('内部预留供应商标识无效');
  const before=id?get(id):null;if(before&&input.revision!==before.revision)throw fail('供应商资料已变化，请刷新后重新编辑',409);
  const data=normalizeSupplier(input),others=profiles().filter(p=>p.id!==id);
  if(others.some(p=>p.name.toLocaleLowerCase()===data.name.toLocaleLowerCase()))throw fail('供应商名称已存在，请编辑现有档案',409);
  for(const shop of data.shops){const owner=db.prepare('SELECT profile_id FROM supplier_shop_links WHERE platform=? AND shop_name=?').get(shop.platform,shop.name);if(owner&&owner.profile_id!==id)throw fail(shop.platform+' · '+shop.name+' 已关联其他供应商',409);}
  const now=new Date().toISOString(),profileId=id||reservedId||randomUUID(),revision=(before?.revision||0)+1;
  if(before)db.prepare('UPDATE supplier_profiles SET data_json=?,revision=?,updated_at=? WHERE id=?').run(JSON.stringify(data),revision,now,id);
  else db.prepare('INSERT INTO supplier_profiles VALUES(?,?,?,?,?)').run(profileId,JSON.stringify(data),revision,now,now);
  db.prepare('DELETE FROM supplier_shop_links WHERE profile_id=?').run(profileId);
  for(const s of data.shops)db.prepare('INSERT INTO supplier_shop_links VALUES(?,?,?)').run(profileId,s.platform,s.name);
  const after=get(profileId);db.prepare('INSERT INTO supplier_profile_history(profile_id,before_json,after_json,created_at) VALUES(?,?,?,?)').run(profileId,before?JSON.stringify(before):null,JSON.stringify(after),now);return after;
 });
 const enrich=(profile,orders)=>{
  const keys=new Set(profile.shops.map(s=>key(s.platform,s.name))),related=orders.filter(o=>keys.has(key(o.platform,o.supplier))),byShop=supplierSummary(related);
  const products=new Map();for(const o of related)for(const i of o.items){const k=JSON.stringify([i.title,i.spec||'',i.sku||'']);if(!products.has(k))products.set(k,{name:i.title,spec:i.spec||'',sku:i.sku||'',unit:i.unit||'',priceCents:i.unitPriceCents??null,note:''});}
  const linkedAddresses=addresses.list().filter(a=>keys.has(key(a.platform,a.supplier)));
  return {...profile,historicalProducts:[...products.values()],linkedAddresses,byShop,orderCount:related.length,netCents:byShop.reduce((n,s)=>n+s.netCents,0)};
 };
 const list=({q='',platform=''}={})=>{
  const orders=store.list(),managed=profiles(),linked=new Set(managed.flatMap(p=>p.shops.map(s=>key(s.platform,s.name))));
  const virtual=supplierSummary(orders).filter(s=>!linked.has(key(s.platform,s.supplier))).map(s=>{
   const related=orders.filter(o=>o.platform===s.platform&&o.supplier===s.supplier),seen=new Set(),contacts=[];
   for(const o of related){if(!o.supplierContact)continue;const k=JSON.stringify(o.supplierContact);if(!seen.has(k)){seen.add(k);contacts.push({label:'历史联系地址',...o.supplierContact,note:''});}}
   return {id:null,name:s.supplier,contact:'',phone:'',wechat:'',note:'',shops:[{platform:s.platform,name:s.supplier,url:'',account:s.accounts[0]||'',note:''}],products:[],addresses:contacts};
  });
  const keyword=String(q).toLocaleLowerCase();return [...managed,...virtual].map(p=>enrich(p,orders)).filter(p=>(!platform||p.shops.some(s=>s.platform===platform))&&(!keyword||JSON.stringify([p.name,p.contact,p.phone,p.wechat,p.note,p.shops,p.products,p.historicalProducts,p.addresses]).toLocaleLowerCase().includes(keyword)));
 };
 return {profiles,get,save,list,history:id=>{get(id);return db.prepare('SELECT * FROM supplier_profile_history WHERE profile_id=? ORDER BY id DESC').all(id).map(r=>({id:r.id,createdAt:r.created_at,before:r.before_json?JSON.parse(r.before_json):null,after:JSON.parse(r.after_json)}));}};
}
