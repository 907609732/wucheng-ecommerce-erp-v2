import {money,dateValue,statusValue,deliveryKeys} from './importer.mjs';

const empty=v=>v==null||String(v).trim()==='';
const text=v=>String(v??'').trim();
const unknownAccount=v=>['','待补充','默认账号'].includes(text(v));
const cleanSpec=v=>text(v).replace(/^(商品规格|颜色分类|饰面颜色)\s*[:：]\s*/,'');
const unique=values=>[...new Set(values.filter(v=>!empty(v)).map(text))];
const itemKey=i=>JSON.stringify([text(i.title),cleanSpec(i.spec),Number(i.qty),i.unitPriceCents]);

export function buildTaobaoSupplement(table,orders){
 const required=['订单ID','用户名','下单日期','商家名','订单状态','本单实付总款','商品名','规格','价格','数量','收货地址','收货人电话','付款时间','物流公司','运单号'];
 if(required.some(h=>!table.headers.includes(h)))throw Error('文件不是已核验的淘宝数据库导出格式');
 const groups=new Map();
 for(const row of table.rows){
  const r=Object.fromEntries(table.headers.map((h,i)=>[h,row.cells[i]]));
  const no=text(r['订单ID']);if(!no)throw Error(`第 ${row.row} 行缺少订单ID`);
  if(typeof r['订单ID']==='number'&&!Number.isSafeInteger(r['订单ID']))throw Error(`第 ${row.row} 行订单ID可能丢失精度`);
  if(!groups.has(no))groups.set(no,[]);groups.get(no).push({raw:row,values:r});
 }
 const entries=[],skipped=[],fieldCounts={};
 for(const [no,sourceRows] of groups){
  const rs=sourceRows.map(r=>r.values),accounts=unique(rs.map(r=>r['用户名']));
  const candidates=orders.filter(o=>o.platform==='淘宝'&&o.orderNo===no);
  const reject=reason=>skipped.push({orderNo:no,reason});
  if(accounts.length!==1||unknownAccount(accounts[0])){reject('源表采购账号缺失或存在多个账号');continue;}
  const exact=candidates.filter(o=>o.account===accounts[0]);
  const o=exact.length===1?exact[0]:candidates.length===1&&unknownAccount(candidates[0].account)?candidates[0]:null;
  if(!o){reject(candidates.length?'账号归属不明确，保留现有记录':'系统内未找到订单，本次只补充已有订单');continue;}
  const amounts=unique(rs.map(r=>r['本单实付总款'])).map(v=>money(v));
  const dates=unique(rs.map(r=>dateValue(r['下单日期'])));
  const suppliers=unique(rs.map(r=>r['商家名']));
  const statuses=unique(rs.map(r=>statusValue(r['订单状态'])));
  if(amounts.length!==1||amounts[0]!==o.amountCents||dates.length!==1||dates[0]!==o.date||suppliers.length!==1||suppliers[0]!==o.supplier||statuses.length!==1||statuses[0]!==o.status){reject('金额、日期、店铺或状态不一致，需另行核对');continue;}
  const sourceItems=rs.map(r=>({title:r['商品名'],spec:r['规格'],qty:Number(r['数量']),unitPriceCents:money(r['价格'])}));
  if(JSON.stringify(sourceItems.map(itemKey).sort())!==JSON.stringify(o.items.map(itemKey).sort())){reject('商品明细不一致，保留现有明细');continue;}
  const patch={},conflicts=[];
  const fill=(key,value)=>{
   if(empty(value))return;
   if(empty(o[key])||(key==='account'&&unknownAccount(o[key])))patch[key]=value;
   else if(o[key]!==value)conflicts.push(key);
  };
  fill('account',accounts[0]);
  const paid=unique(rs.map(r=>r['付款时间'])).map(dateValue);
  if(new Set(paid).size===1)fill('paidAt',paid[0]);else if(paid.length)conflicts.push('paidAt');
  const addresses=unique(rs.map(r=>r['收货地址']));
  const phones=unique(rs.map(r=>r['收货人电话']));
  const parsed=addresses.map(a=>{
   const parts=a.split(/[，,]/).map(text);
   return parts.length===5&&parts[0]&&parts[1]&&!parts[2]&&parts[3]&&/^\d{6}$/.test(parts[4])&&phones.includes(parts[1])?{recipient:parts[0],phone:parts[1],address:parts[3]}:null;
  });
  if(parsed.length&&parsed.every(Boolean)){
   for(const key of ['recipient','phone','address'])fill(key,unique(parsed.map(p=>p[key])).join('；'));
  }else{
   fill('phone',phones.join('；'));
   if(addresses.length)conflicts.push('收货地址格式需核对，完整值已保存在补充原始数据');
  }
  for(const [key,column] of [['logisticsCompany','物流公司'],['trackingNo','运单号']])fill(key,unique(rs.map(r=>r[column])).join('；'));
  Object.keys(patch).forEach(k=>fieldCounts[k]=(fieldCounts[k]||0)+1);
  entries.push({id:o.id,orderNo:no,updatedAt:o.updatedAt,patch,conflicts,original:{sheet:table.sheet,headers:table.headers,rows:sourceRows.map(r=>r.raw)}});
 }
 return {entries,skipped,summary:{sourceOrders:groups.size,sourceRows:table.rows.length,matched:entries.length,updated:entries.filter(e=>Object.keys(e.patch).length).length,skipped:skipped.length,fields:fieldCounts,fieldConflicts:entries.reduce((s,e)=>s+e.conflicts.length,0)}};
}

export const supplementFields=['account','paidAt',...deliveryKeys];
