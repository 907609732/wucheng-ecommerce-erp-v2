import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,json,fail} from './util.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function currentPath(id){
 const file=process.env.LINGTU_REGISTRY_PATH;
 if(file&&fs.existsSync(file)){
  const registry=JSON.parse(fs.readFileSync(file,'utf8'));
  if(registry[id]?.dataDir)return path.join(registry[id].dataDir,id==='purchase'?'purchases.sqlite':'sales.sqlite');
 }
 return id==='purchase'?(process.env.OVERVIEW_PURCHASE_DB||path.resolve(root,'../data/purchases.sqlite')):(process.env.OVERVIEW_SALES_DB||path.resolve(root,'../../销售台/data/sales.sqlite'));
}
export const defaultPaths={get purchase(){return currentPath('purchase');},get sales(){return currentPath('sales');}};
export function readDb(file,fn){if(!fs.existsSync(file))throw fail('源账本不存在：'+file,503);let db;try{db=new DatabaseSync(file,{readOnly:true,timeout:3000});db.exec('BEGIN');const out=fn(db);db.exec('COMMIT');return out;}catch(e){throw fail('源账本读取失败：'+e.message,503);}finally{db?.close();}}
export function loadSources(paths=defaultPaths){
 paths={...paths};
 const result={paths,errors:[],purchase:[],sales:[],shops:[],coverage:[],imports:[],sourceVersions:{}};
 try{const p=readDb(paths.purchase,d=>({orders:d.prepare('SELECT * FROM orders ORDER BY id').all(),imports:d.prepare('SELECT * FROM imports ORDER BY id').all()}));result.purchase=p.orders;result.purchaseImports=p.imports;result.sourceVersions.purchase=hash(p);}catch(e){result.errors.push({source:'采购台',message:e.message});}
 try{const s=readDb(paths.sales,d=>{const all=sql=>d.prepare(sql).all();const locks=all('SELECT month,snapshot FROM month_locks ORDER BY month');const locked=new Set(locks.map(x=>x.month));const rows=all('SELECT * FROM active_ledger ORDER BY id').filter(r=>!locked.has(r.date.slice(0,7)));for(const l of locks){const snap=JSON.parse(l.snapshot);if(!Array.isArray(snap.ledger))throw Error('锁定月快照缺少流水');rows.push(...snap.ledger);}return {rows,shops:all("SELECT * FROM shops WHERE platform<>'待归属' ORDER BY id"),coverage:all('SELECT * FROM coverage ORDER BY shop_id,month,dataset'),imports:all("SELECT i.* FROM imports i WHERE status='committed' AND NOT EXISTS(SELECT 1 FROM batch_attributions b WHERE b.import_id=i.id AND b.status='unassigned') ORDER BY id"),locks};});result.sales=s.rows;result.shops=s.shops;result.coverage=s.coverage;result.imports=s.imports;result.sourceVersions.sales=hash(s);}catch(e){result.errors.push({source:'销售台',message:e.message});}
 result.revision=hash(result.sourceVersions);return result;
}
export function saleBucket(r){
 const c=(r.category||'').split('|')[0];
 // Business codes override legacy kind: deposits were historically platform_flow.
 if(['transfer','withdrawal'].includes(r.kind)||/^007|^008/.test(c))return 'transfer';
 if(r.kind==='receipt')return 'receipt';
 if(r.source==='拼多多货款账务明细'){
  if(['0010002','0010005','0130005'].includes(c))return 'income';
  if(['0020002','0020005'].includes(c))return 'refund';
  if(['0030001','0030002','0040001','0040002','0040003','0040004','0040005','0040014','0050002','0050004','0060001','0110001'].includes(c))return 'platformFee';
  return 'unknown';
 }
 if(c==='tb_income')return 'income';if(c==='tb_refund')return 'refund';
 if(r.kind==='sale')return 'income';if(r.kind==='refund')return 'refund';
 if(r.kind==='expense')return r.deducted?'excluded':'platformFee';
 // Unspecified net settlements must be classified before aggregation.
 return 'unknown';
}
export function sourceRecords(s,overrides=[]){
 const byId=new Map(overrides.map(x=>[x.source_key,x]));const out=[];
 for(const r of s.sales){const meta=json(r.note);const o=byId.get('sales:'+r.id);let bucket=saleBucket(r);if(o&&o.source_hash===hash(r))bucket=o.bucket;let amount=r.amount;
  if(['sale','refund','expense'].includes(r.kind))amount=['refund','expense'].includes(r.kind)?-Math.abs(amount):Math.abs(amount);
  const currency=r.currency||'CNY';out.push({key:'sales:'+r.id,source:'sales',sourceId:r.id,date:r.date,bucket:currency==='CNY'?bucket:'unknown',amountCents:amount,currency,owner:r.shop_id,party:s.shops.find(x=>x.id===r.shop_id)?.name||'待确认店铺',title:r.category||r.kind,number:meta.order_ref||r.order_ref||r.external_id,sourceFile:s.imports.find(x=>x.id===r.batch_id)?.filename||r.source,sourceRow:meta.source_row||null,sourceHash:hash(r),raw:r,reason:currency!=='CNY'?'外币保留原值，未计入人民币差额':o&&o.source_hash!==hash(r)?'源流水已变化，分类须复核':bucket==='excluded'?'平台已扣费用展示记录，避免重复扣减':''});
 }
 for(const r of s.purchase){const included=!r.excluded_from_spend&&['已完成','待发货','待收货'].includes(r.status);const c=json(r.classification,{mode:'single',category:'goods'});const parts=c.mode==='split'?c.parts:[{category:c.category,amountCents:r.amount_cents,refundCents:r.refund_cents}];const base={source:'purchase',sourceId:r.id,date:r.paid_at||r.date,currency:'CNY',owner:'company',party:r.supplier,number:r.order_no,sourceFile:s.purchaseImports?.find(x=>x.id===r.source_id)?.filename||'手工采购',sourceHash:hash(r),raw:r,estimated:!r.paid_at,shippingCents:r.shipping_cents||0,reason:included?'':r.excluded_from_spend?'采购台已手动排除':'订单状态：'+r.status};
  for(const [index,p]of parts.entries())out.push({...base,key:'purchase:'+r.id+':'+index,bucket:included?'purchase':'excluded',title:({goods:'商品采购',fixed_asset:'固定资产采购',expense:'日常支出'})[p.category]||p.category,amountCents:-p.amountCents});
  if(included&&r.refund_cents>0){const o=byId.get('purchase:'+r.id+':refund');const valid=o&&o.source_hash===hash(r)&&o.refund_date;out.push({...base,key:'purchase:'+r.id+':refund',date:valid?o.refund_date:'',bucket:valid?'purchase':'pendingRefund',title:'采购退款',amountCents:r.refund_cents,estimated:false,reason:valid?'已补充退款发生日期':'原账本仅有累计退款，待补实际退款日期'});}
 }
 return out;
}
export function sourceTarget(s,key){if(key.startsWith('purchase:')){const r=s.purchase.find(x=>'purchase:'+x.id===key);if(!r||r.excluded_from_spend||!['已完成','待发货','待收货'].includes(r.status))throw fail('关联采购不存在或未计入采购支出');return {raw:r,amount:r.amount_cents-r.refund_cents};}if(key.startsWith('sales:')){const r=s.sales.find(x=>'sales:'+x.id===key);if(!r||saleBucket(r)!=='platformFee'||r.amount>=0||r.currency!=='CNY')throw fail('只能关联已确认的人民币平台费用');return {raw:r,amount:-r.amount};}throw fail('关联来源无效');}
export function sourceOriginal(s,source,id){const r=source==='purchase'?s.purchase.find(x=>x.id===id):s.sales.find(x=>x.id===id);if(!r)throw fail('源记录不存在',404);const imp=source==='purchase'?s.purchaseImports.find(x=>x.id===r.source_id):s.imports.find(x=>x.id===r.batch_id);if(!imp)throw fail('该记录没有原始文件',404);const base=path.dirname(s.paths[source]);const file=path.resolve(base,source==='purchase'?imp.file_path:imp.original_path);if(!file.startsWith(base+path.sep)||!fs.existsSync(file))throw fail('原件路径无效或文件缺失',404);return {file,name:imp.filename};}
