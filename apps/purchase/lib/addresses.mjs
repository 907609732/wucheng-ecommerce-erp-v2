import {randomUUID} from 'node:crypto';
import {importRules} from '../public/import-rules.mjs';

const error=(message,status=400)=>Object.assign(Error(message),{status});
export const quickTags=['收货地址','供应商地址'];

// 地址库条目规范化：名称必填；标签接受数组或逗号 / 分号 / 空格分隔的字符串。
export function normalizeAddress(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw error('请填写地址信息');
 const name=String(input.name??'').trim();
 if(!name)throw error('请填写联系人 / 供应商名称');
 if(name.length>200)throw error('名称最多 200 字');
 const phone=String(input.phone??'').trim();if(phone.length>40)throw error('联系电话最多 40 字');
 const address=String(input.address??'').trim();if(address.length>4000)throw error('地址最多 4,000 字');
 const note=String(input.note??'').trim();if(note.length>2000)throw error('备注最多 2,000 字');
 const raw=Array.isArray(input.tags)?input.tags:String(input.tags||'').split(/[,，;；\s]+/);
 const tags=[...new Set(raw.map(t=>String(t??'').trim()).filter(Boolean))];
 if(tags.length>20)throw error('标签最多 20 个');
 for(const t of tags)if(t.length>20)throw error('单个标签最多 20 字');
 const platform=String(input.platform||'').trim(),supplier=String(input.supplier||'').trim();
 if(platform&&!Object.hasOwn(importRules,platform)||supplier.length>200||!!platform!==!!supplier)throw error('关联供应商时请同时填写有效平台和供应商');
 return {name,phone,address,tags,note,platform,supplier};
}

// 地址库：收货地址与供应商地址二合一，自由标签 + 常用标签快捷填入，按标签筛选。
export function openAddresses(store){
 const {db}=store;
 db.exec(`CREATE TABLE IF NOT EXISTS addresses(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL DEFAULT '[]',note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS addresses_name ON addresses(name);`);
 for(const name of ['platform','supplier'])if(!db.prepare('PRAGMA table_info(addresses)').all().some(c=>c.name===name))db.exec(`ALTER TABLE addresses ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
 const decode=r=>({id:r.id,name:r.name,phone:r.phone,address:r.address,tags:JSON.parse(r.tags||'[]'),note:r.note,platform:r.platform,supplier:r.supplier,createdAt:r.created_at,updatedAt:r.updated_at});
 const list=({q='',tag=''}={})=>{
  const keyword=String(q||'').trim().toLocaleLowerCase();
  return db.prepare('SELECT * FROM addresses ORDER BY updated_at DESC,created_at DESC').all().map(decode)
   .filter(a=>(!tag||a.tags.includes(tag))&&(!keyword||[a.name,a.phone,a.address,a.note,a.platform,a.supplier,...a.tags].join(' ').toLocaleLowerCase().includes(keyword)));
 };
 const create=(input,{reservedId}={})=>{
  if(reservedId&&!/^[a-f0-9-]{36}$/i.test(reservedId))throw error('内部预留地址标识无效');
  const a=normalizeAddress(input),id=reservedId||randomUUID(),now=new Date().toISOString();
  db.prepare('INSERT INTO addresses(id,name,phone,address,tags,note,platform,supplier,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,a.name,a.phone,a.address,JSON.stringify(a.tags),a.note,a.platform,a.supplier,now,now);
  return decode(db.prepare('SELECT * FROM addresses WHERE id=?').get(id));
 };
 const update=(id,input)=>{
  const prior=db.prepare('SELECT updated_at FROM addresses WHERE id=?').get(id);if(!prior)throw error('地址不存在',404);
  if(input.updatedAt!==prior.updated_at)throw error('地址已变化，请刷新后重试',409);
  const a=normalizeAddress(input),now=new Date(Math.max(Date.now(),Date.parse(prior.updated_at)+1)).toISOString();
  const r=db.prepare('UPDATE addresses SET name=?,phone=?,address=?,tags=?,note=?,platform=?,supplier=?,updated_at=? WHERE id=? AND updated_at=?').run(a.name,a.phone,a.address,JSON.stringify(a.tags),a.note,a.platform,a.supplier,now,id,input.updatedAt);
  if(!r.changes)throw error('地址已变化，请刷新后重试',409);
  if(!r.changes)throw error('地址不存在',404);
  return decode(db.prepare('SELECT * FROM addresses WHERE id=?').get(id));
 };
 const remove=(id,input={})=>{
  const prior=db.prepare('SELECT updated_at FROM addresses WHERE id=?').get(id);if(!prior)throw error('地址不存在',404);
  if(input.updatedAt!==prior.updated_at)throw error('地址已变化，请刷新后重试',409);
  const r=db.prepare('DELETE FROM addresses WHERE id=? AND updated_at=?').run(id,input.updatedAt);
  if(!r.changes)throw error('地址已变化，请刷新后重试',409);
  return {ok:true};
 };
 return {list,create,update,remove,quickTags};
}
