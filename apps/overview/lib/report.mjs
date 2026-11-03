import {sourceRecords} from './sources.mjs';
import {hash,month,sum,BUCKETS} from './util.mjs';
export function prepareReport(s,sources){
 const overrides=s.all('SELECT * FROM overrides ORDER BY source_key');
 return {overrides,all:sourceRecords(sources,overrides),bills:s.bills().filter(b=>!b.voided),payments:s.payments().filter(p=>!p.voided)};
}
export function report(s,sources,m,prepared=prepareReport(s,sources)){
 month(m);const {overrides,all,bills,payments}=prepared;
 const billMap=new Map(bills.map(b=>[b.id,b]));const rows=all.filter(r=>r.date.startsWith(m));
 for(const p of payments.filter(p=>p.date.startsWith(m))){const b=billMap.get(p.billId);if(!b)continue;rows.push({key:'payment:'+p.id,source:'payment',sourceId:p.id,billId:b.id,date:p.date,bucket:b.linkedSource?'excluded':b.kind,amountCents:(p.direction==='refund'?1:-1)*p.amountCents,currency:'CNY',owner:b.owner,party:b.party,title:b.title,number:p.reference,sourceFile:b.billNo,reason:b.linkedSource?'已关联源记录，仅展示付款，不重复扣减':'',linkedSource:b.linkedSource,raw:{bill:b,payment:p}});}
 const coverage=s.all('SELECT * FROM coverage WHERE month=? ORDER BY category',m);
 const signatures={};for(const k of ['freight','payroll','other','purchase','sales'])signatures[k]=hash({rows:rows.filter(r=>['sales','purchase'].includes(k)?r.source===k:r.source==='payment'&&billMap.get(r.billId)?.kind===k).map(r=>[r.key,r.amountCents,r.sourceHash,r.raw]),bills:bills.filter(b=>b.kind===k&&b.period===m)});
 const state=k=>{const c=coverage.find(c=>c.category===k);if(!c)return {status:'missing'};return {...c,status:c.revision===signatures[k]?c.status:'stale'};};
 const totals={};for(const k of ['income','refund','platformFee','purchase','freight','payroll','other','transfer','receipt']){const r=rows.filter(r=>r.bucket===k&&r.currency==='CNY');totals[k]=r.length?sum(r.map(x=>x.amountCents)):['full','zero'].includes(state(k==='purchase'?'purchase':['income','refund','platformFee'].includes(k)?'sales':k).status)?0:null;}
 const included=rows.filter(r=>['income','refund','platformFee','purchase','freight','payroll','other'].includes(r.bucket)&&r.currency==='CNY');
 const knownDifference=included.length?sum(included.map(r=>r.amountCents)):['income','refund','platformFee','purchase','freight','payroll','other'].some(k=>totals[k]!=null)?0:null;
 const debts=bills.filter(b=>b.period<=m).map(b=>{const paid=sum(payments.filter(p=>p.billId===b.id&&p.date.slice(0,7)<=m).map(p=>p.direction==='refund'?-p.amountCents:p.amountCents));return {...b,paidCents:paid,pendingCents:b.amountCents-paid};}).filter(b=>b.pendingCents>0);
 const issues=[];const add=(type,title,count,amountCents,keys=[])=>issues.push({type,title,count,amountCents,keys});
 const missingPaid=rows.filter(r=>r.bucket==='purchase'&&r.estimated);if(missingPaid.length)add('purchase_dates','采购付款日期缺失，暂按下单日归月',new Set(missingPaid.map(r=>r.sourceId)).size,sum(missingPaid.map(r=>-r.amountCents)),missingPaid.map(r=>r.key));
 const refunds=all.filter(r=>r.bucket==='pendingRefund');if(refunds.length)add('refund_dates','采购累计退款待补实际发生日期（跨月待办）',refunds.length,sum(refunds.map(r=>r.amountCents)),refunds.map(r=>r.key));
 const unknown=rows.filter(r=>r.bucket==='unknown');if(unknown.length)add('unknown','未分类或外币流水，暂未计入人民币差额',unknown.length,null,unknown.map(r=>r.key));
 const staleOverrides=rows.filter(r=>r.reason.includes('分类须复核'));if(staleOverrides.length)add('classification_changed','源流水已变化，请重新确认分类',staleOverrides.length,null,staleOverrides.map(r=>r.key));
 const domainStatus=['sales','purchase','freight','payroll','other'].map(k=>({category:k,...state(k),signature:signatures[k]}));
 for(const c of domainStatus)if(!['full','zero'].includes(c.status))add('coverage',({sales:'销售账单',purchase:'采购支出',freight:'运费',payroll:'人力',other:'其他费用'})[c.category]+(c.status==='stale'?'已变化，需重新确认':'尚未确认录全'),1,null);
 if(!rows.some(r=>r.bucket==='receipt'))add('receipt','尚未取得本月独立的实际到账记录',1,null);
 const relevantShops=sources.shops.map(shop=>{const records=rows.filter(r=>r.source==='sales'&&r.owner===shop.id);const c=sources.coverage.filter(c=>c.shop_id===shop.id&&c.month===m);return {...shop,records:records.length,status:c.some(x=>x.dataset==='settlement'&&x.status==='full')?'full':records.length?'partial':'missing'};});
 const missingShops=relevantShops.filter(x=>x.status!=='full');if(missingShops.length)add('shops','店铺账单尚未全部通过整月核对',missingShops.length,null);
 for(const e of sources.errors)add('source',e.source+'读取失败：'+e.message,1,null);
 const sourcePurchase=bills.filter(b=>b.linkedSource&&b.period<=m).filter(b=>!all.some(r=>r.bucket!=='excluded'&&(b.linkedSource===r.key||b.linkedSource==='purchase:'+r.sourceId)));if(sourcePurchase.length)add('broken_links','关联源记录已被排除或不存在，请核对',sourcePurchase.length,null,sourcePurchase.map(b=>'bill:'+b.id));
 const categories=['商品采购','固定资产采购','日常支出'].map(title=>({title,amountCents:sum(rows.filter(r=>r.bucket==='purchase'&&r.title===title).map(r=>r.amountCents))}));
 const purchaseRecords=rows.filter(r=>r.source==='purchase'&&r.bucket==='purchase'&&r.amountCents<0);if(purchaseRecords.length&&purchaseRecords.every(r=>r.title==='商品采购'))add('classification','采购目前均为商品采购，请核对设备、软件和耗材分类',new Set(purchaseRecords.map(r=>r.sourceId)).size,null);
 const revision=hash({m,sourceVersions:sources.sourceVersions,bills:s.bills(),payments:s.payments(),overrides,coverage});
 const snapshots=s.all('SELECT id,month,revision,created_at FROM snapshots WHERE month=? ORDER BY created_at DESC',m).map(x=>({...x,stale:x.revision!==revision}));
 const unavailable=sources.errors.length>0;if(unavailable)for(const k of Object.keys(totals))totals[k]=null;
 return {month:m,revision,generatedAt:new Date().toISOString(),unavailable,sourceVersions:sources.sourceVersions,totals,difference:unavailable?null:knownDifference,complete:issues.length===0,issues,coverage:domainStatus,shops:relevantShops,rows:rows.sort((a,b)=>b.date.localeCompare(a.date)||a.key.localeCompare(b.key)),pendingRefunds:refunds,debts,pendingCents:sum(debts.map(b=>b.pendingCents)),purchaseCategories:categories,snapshots,definitions:'已录收支参考差额 = 已分类平台业务净入账 − 采购及额外实付支出；各项使用来源记录日期。不是利润、银行余额或完整现金流。缺项与待归月记录不自动补零。'};
}
export function selectRows(r,q={}){let rows=q.bucket==='pendingRefund'?r.pendingRefunds:r.rows;if(q.bucket==='reference')rows=rows.filter(x=>['income','refund','platformFee','purchase','freight','payroll','other'].includes(x.bucket));else if(q.bucket==='payments')rows=rows.filter(x=>['purchase','freight','payroll','other'].includes(x.bucket));else if(q.bucket&&q.bucket!=='all')rows=rows.filter(x=>x.bucket===q.bucket);if(q.date)rows=rows.filter(x=>x.date===q.date);if(q.owner&&q.owner!=='all')rows=rows.filter(x=>x.owner===q.owner);if(q.q){const t=String(q.q).toLowerCase();rows=rows.filter(x=>[x.title,x.number,x.party,x.sourceFile].join(' ').toLowerCase().includes(t));}return {rows,count:rows.length,amountCents:sum(rows.filter(x=>x.currency==='CNY').map(x=>x.amountCents)),label:BUCKETS[q.bucket]||'全部明细'};}
