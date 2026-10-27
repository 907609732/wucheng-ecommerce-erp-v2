import {MAX_FILES} from '../public/upload-limits.mjs';
import {normalizeShipments,normalizeContact} from '../public/shipments.mjs';
import {normalizeClassification} from '../public/classification.mjs';
import {normalizeExcluded} from '../public/order-attributes.mjs';
import ExcelJS from 'exceljs';
import {parse} from 'csv-parse/sync';
import {createHash} from 'node:crypto';
import {importRules,isStoredPlatform} from '../public/import-rules.mjs';

export const fields = {
 account:{label:'采购账号 / 买家会员名',aliases:['买家会员名','买家账号','买家会员登录名','采购账号','采购账户','买家旺旺','买家昵称','账号']},
 orderNo:{label:'订单编号', aliases:['订单编号','订单号','主订单编号','主订单号','订单id','订单ID']},
 date:{label:'下单日期', aliases:['订单提交时间','订单创建时间','订单创建日期','创建时间','下单时间','下单日期','成交时间','采购日期','日期']},
 paidAt:{label:'付款日期', aliases:['订单付款时间','付款时间','支付时间','付款日期']},
 supplier:{label:'供应商 / 店铺',aliases:['卖家公司名','卖家店铺','店铺名称','店铺','商家名称','供应商','供应商名称','卖家昵称','卖家会员名']},
 title:{label:'商品名称',aliases:['货品标题','商品名称','商品标题','宝贝标题','宝贝名称','商品','品名']},
 spec:{label:'规格型号',aliases:['型号款式','规格型号','商品规格','规格','型号','商品属性','规格信息']},
 sku:{label:'商品编码',aliases:['SKU ID','SKU','商品编码','商家编码','货号','sku_id']},
 qty:{label:'数量',aliases:['数量','商品数量','购买数量','宝贝总数量','件数']},
 unit:{label:'单位',aliases:['单位','计量单位','商品单位','采购单位','数量单位']},
 unitPrice:{label:'单价',aliases:['单价(元)','单价','商品单价','宝贝单价']},
 amount:{label:'实付金额',aliases:['实付款(元)','实付款','实付金额','买家实付金额','买家实际支付金额','订单实付金额','订单实际支付金额','实付','订单金额','采购金额','金额','应付金额']},
 refund:{label:'已退款金额',aliases:['已退款金额','退款金额','成功退款金额']},
 shipping:{label:'运费',aliases:['运费(元)','运费','快递费','邮费','买家应付邮费']},
 status:{label:'订单状态',aliases:['订单状态','交易状态','状态']},
 platform:{label:'采购平台',aliases:['采购平台','平台','订单来源','来源平台']},
 note:{label:'备注',aliases:['订单备注','备注','买家留言']},
 recipient:{label:'收货人姓名',aliases:['收货人姓名','收货人','收件人','收件人姓名','买家收货人']},
 address:{label:'收货地址',aliases:['收货地址','详细收货地址','收件地址','收货详细地址','详细地址']},
 phone:{label:'联系手机',aliases:['联系手机','收货人手机','收货人手机号','收件人手机号','手机号码','收货人手机号码','联系电话','收货人联系电话','手机']},
 logisticsCompany:{label:'物流公司',aliases:['物流公司','快递公司','物流公司名称','快递公司名称','承运商']},
 trackingNo:{label:'运单号',aliases:['运单号','物流单号','快递单号','物流编号','快递运单号']}
};
export const deliveryKeys=['recipient','address','phone','logisticsCompany','trackingNo'];
export function accountFromOriginal(original){
 const headers=original?.headers||[],index=fields.account.aliases.map(a=>headers.findIndex(h=>norm(h)===norm(a))).find(i=>i>=0);
 if(index==null)return '';
 const values=[...new Set((original.rows||[]).map(r=>String(cellValue(r.cells?.[index])).trim()).filter(Boolean))];
 return values.length===1?values[0]:'';
}
export const deliveryOf=o=>Object.fromEntries(deliveryKeys.map(k=>[k,String(o[k]??'').trim()]));
export function deliveryFromOriginal(original){
 const result=deliveryOf(original?.normalized||original||{});
 if(!Array.isArray(original?.headers)||!Array.isArray(original?.rows))return result;
 for(const key of deliveryKeys){
  const indices=fields[key].aliases.map(a=>original.headers.findIndex(h=>norm(h)===norm(a))).filter(i=>i>=0);
  const values=original.rows.map(r=>indices.map(i=>cellValue(r.cells?.[i])).find(v=>v!==''&&v!=null)).filter(v=>v!==undefined).map(v=>String(v).trim()).filter(Boolean);
  if(values.length)result[key]=[...new Set(values)].join('；');
 }
 return result;
}
const norm = v=>String(v??'').trim().replace(/[\s（）()：:]/g,'').toLowerCase();
export function cellValue(v){
 if(v==null)return '';
 if(v instanceof Date)return v.toISOString().replace('T',' ').slice(0,19);
 if(typeof v==='object'){
  if('result'in v)return cellValue(v.result);
  if(v.richText)return v.richText.map(x=>x.text).join('');
  if(v.text)return v.text;
  return '';
 }return v;
}
export function money(v, optional=false){
 if(v==null||String(v).trim()===''){if(optional)return 0;throw Error('缺少实付金额');}
 const s=String(v).trim().replace(/[,，￥¥元\s]/g,'');
 if(!/^\d+(?:\.\d{1,2})?$/.test(s))throw Error('金额须为非负数字，最多两位小数');
 const [a,b='']=s.split('.');const cents=Number(a)*100+Number(b.padEnd(2,'0'));
 if(!Number.isSafeInteger(cents)||cents>1e12)throw Error('金额过大');return cents;
}
export function dateValue(v){
 if(v instanceof Date)v=v.toISOString().slice(0,10);
 if(typeof v==='number'&&v>20000&&v<100000)v=new Date(Date.UTC(1899,11,30)+v*86400000).toISOString().slice(0,10);
 const m=String(v??'').trim().match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})(?:日|\b)/);
 if(!m)throw Error('日期缺失或格式不正确');
 const s=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
 const d=new Date(s+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)throw Error('日期不存在');return s;
}
export function statusValue(v){
 const s=String(v||'待核对').trim();
 if(/待付款|等待买家付款|未付款|未支付/.test(s))return '待付款';
 if(/关闭|取消|全额退款|退款成功/.test(s))return '已关闭';
 if(/成功|完成|已收货|已签收|待评价|已评价/.test(s))return '已完成';
 if(/待收货|等待买家收货|已发货|卖家已发货/.test(s))return '待收货';
 if(/待发货|已付款|买家已付款|待发出/.test(s))return '待发货';
 if(['待核对','已关闭','已完成'].includes(s))return s;
 return '待核对';
}
export function detectMapping(headers){
 const mapping={};for(const [key,f]of Object.entries(fields)){
  for(const a of f.aliases){const i=headers.findIndex(h=>norm(h)===norm(a));if(i>=0){mapping[key]=String(i);break;}}
 }return mapping;
}
export async function readTable(buffer,name,sheetName){
 let sheets=[];
 if(/\.csv$/i.test(name)){
  let txt=new TextDecoder('utf-8',{fatal:false}).decode(buffer);if(txt.includes('\ufffd'))txt=new TextDecoder('gb18030').decode(buffer);
  sheets=[{name:'CSV',rows:parse(txt,{bom:true,relax_column_count:true,skip_empty_lines:true})}];
 }else if(/\.xlsx$/i.test(name)){
  try{
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
   sheets=wb.worksheets.map(s=>({name:s.name,rows:Array.from({length:s.rowCount},(_,i)=>Array.from({length:s.columnCount},(_,j)=>cellValue(s.getCell(i+1,j+1).value)))}));
  }catch{
   const {readCompatibleXlsx}=await import('./xlsx-compat.mjs');sheets=readCompatibleXlsx(buffer);
  }
 }else throw Error('请导入 .xlsx 或 .csv 文件；旧版 .xls 请先另存为 .xlsx');
 const s=sheets.find(s=>s.name===sheetName)||sheets[0];if(!s||!s.rows.length)throw Error('表格为空');
 if(s.rows.length>50001)throw Error('单次最多导入 50,000 行');
 let headerIndex=0,best=-1;
 s.rows.slice(0,20).forEach((row,i)=>{const score=Object.keys(detectMapping(row)).length;if(score>best){best=score;headerIndex=i;}});
 const headers=s.rows[headerIndex].map((x,i)=>String(x||`未命名列 ${i+1}`));
 return {sheets:sheets.map(s=>s.name),sheet:s.name,headers,headerRow:headerIndex+1,rows:s.rows.slice(headerIndex+1).map((cells,i)=>({row:headerIndex+i+2,cells})).filter(r=>r.cells.some(v=>v!==''&&v!=null)),mapping:detectMapping(headers)};
}
export const fingerprint=o=>createHash('sha256').update(JSON.stringify({platform:o.platform,account:o.account,orderNo:o.orderNo,date:o.date,paidAt:o.paidAt||'',supplier:o.supplier,amountCents:o.amountCents,refundCents:o.refundCents||0,shippingCents:o.shippingCents||0,status:o.status,note:o.note||'',...deliveryOf(o),items:o.items.map(({title,spec,sku,qty,unitPriceCents,unit,trackingNo,logisticsCompany})=>({title,spec,sku,qty,unitPriceCents,unit:String(unit??'').trim(),trackingNo:String(trackingNo??'').trim(),logisticsCompany:String(logisticsCompany??'').trim()}))})).digest('hex');
export function backfillItemUnits(items,original){
 const source=original?.normalized?.items||original?.items||original?.recognized?.items||[];
 const unitIndex=fields.unit.aliases.map(a=>(original?.headers||[]).findIndex(h=>norm(h)===norm(a))).find(i=>i>=0);
 const byRow=new Map((original?.rows||[]).map(r=>[r.row,r]));
 const key=i=>JSON.stringify([i.title,i.spec||'',i.sku||'',i.qty,i.unitPriceCents]);
 const sourceUnits=source.map(i=>String(i.unit??(unitIndex==null?'':cellValue(byRow.get(i.sourceRow)?.cells?.[unitIndex]))).trim());
 const unchanged=source.length===items.length&&items.every((i,n)=>key(i)===key(source[n]));
 return items.map((i,n)=>{
  if(Object.hasOwn(i,'unit'))return {...i,unit:String(i.unit??'').trim()};
  const candidates=[...new Set(source.flatMap((s,j)=>key(i)===key(s)?[sourceUnits[j]]:[]))];
  return {...i,unit:unchanged?sourceUnits[n]:candidates.length===1?candidates[0]:''};
 });
}
export function normalizeTable(table,{mapping=table.mapping,platform='1688',account='默认账号',amountMode='order'}={}){
 const groups=new Map(),issues=[],ambiguousAccounts=new Set();
 const getCell=(row,k)=>mapping[k]==null||mapping[k]===''?'':row.cells[Number(mapping[k])];
 const accountGroups=new Map();
 const orderKey=row=>JSON.stringify([String(getCell(row,'platform')||platform).trim(),String(getCell(row,'orderNo')??'').trim().replace(/^'/,'')]);
 for(const row of table.rows){const a=String(getCell(row,'account')??'').trim(),k=orderKey(row);if(!accountGroups.has(k))accountGroups.set(k,new Set());if(a)accountGroups.get(k).add(a);}
 if(mapping.amount==null||mapping.amount==='')throw Error('请选择实付金额列');
 if((mapping.date==null||mapping.date==='')&&(mapping.paidAt==null||mapping.paidAt===''))throw Error('请选择下单日期或付款日期列');
 for(const row of table.rows){
  const get=k=>mapping[k]==null||mapping[k]===''?'':row.cells[Number(mapping[k])];
  const noVal=get('orderNo');let no=String(noVal??'').trim().replace(/^'/,'');
  if(!no){issues.push({row:row.row,message:'缺少订单号，请补充编号后重试；手工采购可使用自定编号'});continue;}
  const sourcePlatform=String(get('platform')||platform).trim();
  const candidates=accountGroups.get(orderKey(row)),rowAccount=String(get('account')??'').trim();
  if(!rowAccount&&candidates.size>1){issues.push({row:row.row,message:'同一订单号涉及多个采购账号，此行账号为空，请补齐后导入'});ambiguousAccounts.add(orderKey(row));continue;}
  const sourceAccount=rowAccount||(candidates.size===1?[...candidates][0]:String(account||'默认账号').trim()||'默认账号');
  const key=JSON.stringify([sourcePlatform,sourceAccount,no]);
  if(!groups.has(key))groups.set(key,{key,orderNo:no,platform:sourcePlatform,account:sourceAccount,supplier:String(get('supplier')||'').trim(),date:'',paidAt:'',amountCents:null,refundCents:0,shippingCents:0,status:statusValue(get('status')),originalStatus:String(get('status')||''),note:String(get('note')||''),items:[],sourceRows:[],errors:[],warnings:[],raw:[]});
  const o=groups.get(key);o.sourceRows.push(row.row);o.raw.push({row:row.row,cells:row.cells});
  try{
   if(sourceAccount.length>200)throw Error('采购账号最多 200 字');
   if(typeof noVal==='number'&&!Number.isSafeInteger(noVal))throw Error('订单号以超长数字保存，可能已丢失精度；请重新导出文本订单号');
   if(!Object.hasOwn(importRules,sourcePlatform))throw Error('请选择支持的采购平台');
   const d=dateValue(get('date')||get('paidAt'));const paidAt=get('paidAt')?dateValue(get('paidAt')):'';
   const amount=money(get('amount'));
   const refund=money(get('refund'),true),shipping=money(get('shipping'),true);
   if(o.date&&o.date!==d)throw Error('同一订单出现不同下单日期');
   if(o.amountCents!==null&&amountMode==='order'&&(o.amountCents!==amount||o.refundCents!==refund))throw Error('同一订单出现不同金额；请确认金额是整单金额还是逐行金额');
   if(o.supplier&&get('supplier')&&o.supplier!==String(get('supplier')).trim())throw Error('同一订单出现不同供应商');
   o.date=d;o.paidAt=paidAt||o.paidAt;
   o.amountCents=amountMode==='line'?(o.amountCents||0)+amount:amount;
   o.refundCents=amountMode==='line'?o.refundCents+refund:refund;o.shippingCents=amountMode==='line'?o.shippingCents+shipping:shipping;
   const qty=get('qty')===''||get('qty')==null?1:Number(get('qty'));
   if(!Number.isFinite(qty)||qty<=0)throw Error('商品数量必须大于零');
   const missingPrice=sourcePlatform==='闲鱼'&&(get('unitPrice')==null||String(get('unitPrice')).trim()==='');
   o.items.push({title:String(get('title')||'未填写商品'),spec:String(get('spec')||''),sku:String(get('sku')||''),qty,unit:String(get('unit')||'').trim(),unitPriceCents:missingPrice?null:money(get('unitPrice'),true),sourceRow:row.row});
  }catch(e){o.errors.push(`第 ${row.row} 行：${e.message}`);}
 }
 for(const o of groups.values()){
  if(ambiguousAccounts.has(JSON.stringify([o.platform,o.orderNo])))o.errors.push('此订单存在无法归属账号的商品行，请补齐账号后重试');
  Object.assign(o,deliveryOf({}));
  for(const key of deliveryKeys){
   const mapped=mapping[key];
   if(mapped!=null&&mapped!=='')o[key]=[...new Set(o.raw.map(r=>String(r.cells[Number(mapped)]??'').trim()).filter(Boolean))].join('；');
  }
  if(o.platform==='闲鱼'&&!o.recipient&&!o.phone&&o.address){
   const parts=o.address.split('；').map(a=>a.match(/^(.+?)\s+(1[3-9][0-9*]{9})\s+(.+)$/));
   if(parts.every(Boolean))for(const [key,index] of [['recipient',1],['phone',2],['address',3]])o[key]=[...new Set(parts.map(p=>p[index].trim()))].join('；');
   else o.warnings.push('收货地址未拆分，请对照原表核对收货人和手机');
  }
  if(o.items.some(i=>i.unitPriceCents===null))o.warnings.push('原表未提供商品单价，保留为空，实付款按整单记录');
  if(o.platform==='拼多多'&&o.status==='待核对'&&/^拼过\d+次$/.test(o.originalStatus)){
   const receiptIndex=table.headers.indexOf('收货时间'),logisticsIndex=table.headers.indexOf('快递状态');
   const received=o.raw.map(r=>String(r.cells[receiptIndex]??'').trim());
   const signed=o.raw.every(r=>String(r.cells[logisticsIndex]??'').trim()==='已签收');
   let validDates=false;try{validDates=received.length>0&&received.every(d=>!!d&&dateValue(d)>=o.date);}catch{}
   if(signed&&validDates){
    o.status='已完成';
    const evidence=`原始状态“${o.originalStatus}”；按同表快递状态“已签收”和收货时间 ${[...new Set(received)].join('、')} 归为已完成。`;
    o.note=[o.note,evidence].filter(Boolean).join('\n');o.warnings.push(evidence);
   }
  }
  if(!o.supplier)o.errors.push('供应商为空，请匹配供应商列或补充源表');
  if(!o.paidAt)o.warnings.push('无付款日期，按下单日期归月');
  if(o.status==='已关闭')o.warnings.push('已关闭订单单列，默认不计入有效采购');
  if(o.status==='待核对')o.warnings.push('订单状态待核对，默认不计入有效采购');
  if(o.refundCents>o.amountCents)o.errors.push('退款金额大于实付金额');
  o.fingerprint=fingerprint(o);
 }
 return {orders:[...groups.values()],issues,lineCount:table.rows.length};
}
export function validateOrder(input){
 const o={...input};
 if(o.attachmentIds!==undefined&&(!Array.isArray(o.attachmentIds)||o.attachmentIds.length>MAX_FILES||o.attachmentIds.some(id=>typeof id!=='string'||!id||id.length>64)))throw Error('每单最多 20 个附件，附件列表必须有效');
 Object.assign(o,deliveryOf(o));
 if(deliveryKeys.some(k=>o[k].length>4000))throw Error('收货或物流字段过长');
 if(String(o.note||'').length>10000)throw Error('备注最多 10,000 字');
 if(!isStoredPlatform(o.platform))throw Error('请选择采购平台');
 o.account=String(o.account||'默认账号').trim();o.orderNo=String(o.orderNo||'').trim();
 if(!o.account)o.account='默认账号';if(o.account.length>200)throw Error('采购账号最多 200 字');
 if(!o.orderNo||o.orderNo.length>100)throw Error('请输入有效的订单编号');
 o.date=dateValue(o.date);o.paidAt=o.paidAt?dateValue(o.paidAt):'';
 o.supplier=String(o.supplier||'').trim();o.note=String(o.note||'');
 if(!o.supplier)throw Error('请填写供应商 / 店铺');
 if(o.amountCents==null||o.amountCents==='')throw Error('请填写实付金额');
 for(const key of ['amountCents','refundCents','shippingCents']){o[key]=Number(o[key]??0);if(!Number.isSafeInteger(o[key])||o[key]<0||o[key]>1e12)throw Error('金额须为有效非负金额');}
 if(o.refundCents>o.amountCents)throw Error('退款不能超过实付金额');
 o.status=statusValue(o.status);
 if(!Array.isArray(o.items)||!o.items.length)throw Error('请填写至少一项商品');
 o.items=o.items.map(i=>{const qty=Number(i.qty),unitPriceCents=i.unitPriceCents===null?null:Number(i.unitPriceCents||0),unit=String(i.unit??'').trim(),trackingNo=String(i.trackingNo??'').trim(),logisticsCompany=String(i.logisticsCompany??'').trim();if(!i.title||!Number.isFinite(qty)||qty<=0||(unitPriceCents!==null&&(!Number.isSafeInteger(unitPriceCents)||unitPriceCents<0)))throw Error('请检查商品名称、数量和单价');if(unit.length>100)throw Error('商品单位最多 100 字');if(trackingNo.length>100)throw Error('商品运单号最多 100 字');if(logisticsCompany.length>200)throw Error('商品物流公司最多 200 字');const shipments=normalizeShipments(i);return {title:String(i.title),spec:String(i.spec||''),sku:String(i.sku||''),qty,unitPriceCents,unit,shipments,trackingNo:shipments[0]?.trackingNo||'',logisticsCompany:shipments[0]?.logisticsCompany||''};});
 o.supplierContact=normalizeContact(o.supplierContact);
 o.excludedFromSpend=normalizeExcluded(o.excludedFromSpend);
 o.classification=normalizeClassification(o.classification,o.amountCents,o.refundCents);o.fingerprint=fingerprint(o);return o;
}
export function extractText(text,platform='其他'){
 text=String(text).replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g,'$1');
 const pick=re=>text.match(re)?.[1]?.trim()||'';
 const amount=pick(/(?:实付(?:金额|款)?|合计(?:金额)?|总(?:金额|计)|应付(?:金额)?)[：:\s￥¥]*([\d,]+(?:\.\d{1,2})?)/);
 const date=pick(/(20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2})/);
 const supplier=pick(/(?:供应商|店铺(?:名称)?|卖家|公司名称)[：:\s]+([^\n\r]+)/);
 const orderNo=pick(/(?:订单(?:编号|号)|单据(?:编号|号))[：:\s]*([A-Za-z0-9-]{5,})/);
 const title=pick(/(?:商品(?:名称)?|品名|货品)[：:\s]+([^\n\r]+)/);
 const qty=pick(/(?:数量|件数)[：:\s]+(\d+(?:\.\d+)?)/);
 const unitPrice=pick(/(?:单价)[：:\s￥¥]+(\d+(?:\.\d{1,2})?)/);
 const unit=pick(/(?:计量单位|商品单位|采购单位|数量单位|单位)[：: \t]+([^\s\n\r，,；;]+)/);
 let normalizedDate='';try{normalizedDate=dateValue(date);}catch{}
 return {platform,account:'默认账号',orderNo,date:normalizedDate,paidAt:'',supplier,amountCents:amount?money(amount):null,refundCents:0,shippingCents:0,status:'待核对',note:'图片 / 文本识别录入，请核对原单',items:[{title,spec:'',sku:'',qty:qty?Number(qty):'',unit,unitPriceCents:unitPrice?money(unitPrice):0}]};
}
