import { SHOPS, KINDS, CURRENCIES } from './config.mjs';
import { id, date, money, now, required, fail, month, count, safeSum } from './util.mjs';

export function validateShop(shop,shops=SHOPS) { if(!shops.some(s=>s.id===shop))throw fail('请选择已登记的店铺'); return shop; }
export function normalizeLedger(input,context={},shops=SHOPS) {
  const r={ ...input, ...context };
  const shop_id=validateShop(r.shop_id,shops),kind=required(r.kind,'流水类型');
  if(!KINDS[kind])throw fail('流水类型无效');
  const amount=money(r.amount),currency=String(r.currency||'CNY').toUpperCase();
  if(!CURRENCIES.includes(currency))throw fail('暂支持 CNY、RUB、USD、EUR');
  if(['sale','refund','expense'].includes(kind)&&amount<0)throw fail('销售、退款、费用填正数；收款冲回和结算调整可填负数');
  if(['sale','refund'].includes(kind)&&!shops.find(s=>s.id===shop_id).manual)throw fail('线上销售与退款请从运营报表导入，避免重复统计');
  const category=String(r.category||'').trim();
  if(kind==='expense'&&(!category||/共用|平摊|分摊|云仓|工资|人工|外包|房租|采购|商品成本/.test(category)))throw fail('第一版只记能直接归属单店的费用，请填写费用项目；共用及商品成本暂不计入');
  const deducted=['1','true','是','已扣'].includes(String(r.deducted??'0'))?1:0;
  return {shop_id,date:date(r.date),kind,amount,currency,external_id:required(String(r.external_id||''),'业务编号',100),match_key:String(r.match_key||'').trim().slice(0,150),order_ref:String(r.order_ref||'').trim().slice(0,100),category:category.slice(0,100),deducted,note:String(r.note||'').slice(0,500),source:required(String(r.source||'手工'),'来源',100)};
}
export function normalizeOperation(input,context={},shops=SHOPS) {
  const r={...input,...context},start=date(r.start),end=date(r.end||r.start);
  if(start>end)throw fail('统计结束日期不能早于开始日期');
  const shop_id=validateShop(r.shop_id,shops); if(shops.find(s=>s.id===shop_id).manual)throw fail('线下和代发使用销售登记，不重复导入运营汇总');
  const currency=String(r.currency||'CNY').toUpperCase(); if(!CURRENCIES.includes(currency))throw fail('币种无效');
  const out={shop_id,start,end,currency,definition:required(String(r.definition||''),'来源指标口径',500),compatible:['1','true','是'].includes(String(r.compatible))?1:0,source:required(String(r.source||'官方运营报表'),'来源',100)};
  for(const k of ['sales','refunds','ad_spend','ad_sales']) {out[k]=money(r[k],true);if(out[k]<0)throw fail('运营金额不能为负数');}
  for(const k of ['orders','visitors','buyers'])out[k]=count(r[k]);
  if(['sales','refunds','ad_spend','ad_sales','orders','visitors','buyers'].every(k=>out[k]===null))throw fail('至少填写一项运营指标');
  return out;
}
export function insertObject(s,table,obj) { const keys=Object.keys(obj); s.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...Object.values(obj)); }
export function addLedger(s,input,context={}) {
  const r=normalizeLedger(input,context,s.shops());
  return s.transaction(()=>{
    validateManualRelation(s,r);
    const out={id:id(),...r,batch_id:null,created_at:now(),updated_at:now()}; insertObject(s,'ledger',out);s.audit('ledger.create',out.id,r);return out;
  });
}
export function validateManualRelation(s,r,excludeId='') {
  if(!s.shops().find(x=>x.id===r.shop_id)?.manual||!['refund','receipt'].includes(r.kind))return;
  if(!r.order_ref)throw fail('请填写对应销售的业务编号，以计算应收与分次收款');
  const sale=s.get("SELECT * FROM ledger WHERE shop_id=? AND kind='sale' AND external_id=?",r.shop_id,r.order_ref);
  if(!sale)throw fail('找不到对应销售，请先登记销售');
  if(sale.currency!==r.currency)throw fail('线下与代发收款、退款必须与销售币种一致');
  if(r.date<sale.date)throw fail('收款或退款日期不能早于销售日期');
  if(r.kind==='refund') {
    const total=s.get("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE shop_id=? AND kind='refund' AND order_ref=? AND id<>?",r.shop_id,r.order_ref,excludeId).n;
    if(total+r.amount>sale.amount)throw fail('累计销售退款不能超过销售应收');
  }
}
export function editLedger(s,recordId,input) {
  return s.transaction(()=>{
    const old=s.get('SELECT * FROM ledger WHERE id=?',recordId); if(!old)throw fail('流水不存在',404);
    if(old.batch_id)throw fail('导入流水请在导入批次中撤销后重新导入，原件与审计记录会保留');
    if(s.get('SELECT 1 FROM matches WHERE left_id=? OR right_id=?',recordId,recordId))throw fail('请先撤销该流水的匹配');
    const r=normalizeLedger(input,{shop_id:old.shop_id,source:old.source,kind:old.kind,external_id:old.external_id},s.shops());
    validateManualRelation(s,r,recordId);
    if(old.kind==='sale') {
      const linked=s.all("SELECT * FROM ledger WHERE shop_id=? AND order_ref=? AND kind IN ('refund','receipt')",old.shop_id,old.external_id);
      if(linked.some(l=>l.currency!==r.currency||l.date<r.date)||safeSum(linked.filter(l=>l.kind==='refund').map(l=>l.amount))>r.amount)throw fail('销售修改与已有收款或退款不一致');
    }
    s.run(`UPDATE ledger SET ${Object.keys(r).map(k=>k+'=?').join(',')},updated_at=? WHERE id=?`,...Object.values(r),now(),recordId);
    s.audit('ledger.edit',recordId,{before:old,after:r});return s.get('SELECT * FROM ledger WHERE id=?',recordId);
  });
}
export function deleteLedger(s,recordId,reason) {
  required(reason,'删除原因');
  return s.transaction(()=>{
    const r=s.get('SELECT * FROM ledger WHERE id=?',recordId); if(!r)throw fail('流水不存在',404);
    if(r.batch_id)throw fail('请通过导入批次撤销');
    if(r.kind==='sale'&&s.get('SELECT 1 FROM ledger WHERE shop_id=? AND order_ref=?',r.shop_id,r.external_id))throw fail('销售已有收款或退款，请先处理关联记录');
    s.run('DELETE FROM ledger WHERE id=?',recordId);s.audit('ledger.delete',recordId,{before:r,reason});return {ok:true};
  });
}
export function createMatch(s,input,{reservedId}={}) {
  if(reservedId&&!/^[a-f0-9-]{36}$/i.test(reservedId))throw fail('内部预留匹配标识无效');
  return s.transaction(()=>{
    const left=s.get('SELECT * FROM active_ledger WHERE id=?',input.left_id),right=s.get('SELECT * FROM active_ledger WHERE id=?',input.right_id);
    if(!left||!right||left.kind!=='settlement'||right.kind!=='receipt'||left.shop_id!==right.shop_id)throw fail('请选择同店铺的结算和收款');
    const la=money(input.left_amount),ra=money(input.right_amount);
    if(la===0||ra===0||Math.sign(la)!==Math.sign(left.amount)||Math.sign(ra)!==Math.sign(right.amount))throw fail('匹配金额的正负方向必须与对应流水一致，且不能为零');
    for(const [r,n,col,amt]of [[left,la,'left_id','left_amount'],[right,ra,'right_id','right_amount']]) {
      const used=s.get(`SELECT COALESCE(SUM(${amt}),0) n FROM matches WHERE ${col}=?`,r.id).n;
      if(Math.abs(used+n)>Math.abs(r.amount))throw fail('匹配金额超过剩余未匹配金额');
    }
    if(left.currency===right.currency&&la!==ra)throw fail('同币种分配金额应一致；手续费请依据真实账单单独记录');
    const r={id:reservedId||id(),left_id:left.id,right_id:right.id,left_amount:la,right_amount:ra,reason:required(input.reason,'核对依据',500),created_at:now()};
    insertObject(s,'matches',r);s.audit('match.create',r.id,r);return r;
  });
}
export function removeMatch(s,matchId,reason) { return s.transaction(()=>{required(reason,'撤销原因');const r=s.get('SELECT * FROM matches WHERE id=?',matchId);if(!r)throw fail('匹配不存在',404);s.run('DELETE FROM matches WHERE id=?',matchId);s.audit('match.delete',matchId,{...r,reason});return {ok:true};}); }
export function setCoverage(s,input) {
  const shop=validateShop(input.shop_id,s.shops()),m=month(input.month);
  if(!['operations','settlement','receipt','expense'].includes(input.dataset)||!['missing','partial','full'].includes(input.status))throw fail('覆盖状态无效');
  if(['offline','dropship'].includes(shop)&&input.dataset==='settlement')throw fail('线下与代发没有平台结算数据，属于不适用项');
  const evidence=required(input.evidence,'核对说明',500);
  return s.transaction(()=>{s.run('INSERT INTO coverage VALUES(?,?,?,?,?,?) ON CONFLICT(shop_id,month,dataset) DO UPDATE SET status=excluded.status,evidence=excluded.evidence,updated_at=excluded.updated_at',shop,m,input.dataset,input.status,evidence,now());s.audit('coverage.set',shop,{...input,evidence});return {ok:true};});
}
