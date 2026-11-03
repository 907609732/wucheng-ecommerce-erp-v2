import {agentDigest} from './agent-approval.mjs';

// Metadata describes input draft cells. Domain result amounts remain integer cents.
const editFields=Object.freeze({
 'ledger-create':Object.freeze(['shop_id','date','kind','amount','currency','external_id','source','match_key','order_ref','category','deducted','note']),
 'ledger-update':Object.freeze(['date','amount','currency','match_key','order_ref','category','deducted','note','reason']),
 'freight-create':Object.freeze(['channel','entry_mode','period','shop_id','shipping','packing','materials','storage','other','other_note','pieces','bill_no','tracking_no','note']),
 'freight-update':Object.freeze(['channel','entry_mode','period','shop_id','shipping','packing','materials','storage','other','other_note','pieces','bill_no','tracking_no','note'])
});
const nameOf=id=>String(id||'').replace(/^sales\./,'');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const array=value=>Array.isArray(value)?value:[];
const amount=value=>typeof value==='number'&&Number.isSafeInteger(value)?value:null;
const append=(existing,added)=>[...array(existing).filter(block=>!added.some(next=>next.id===block?.id)),...added];
const isDay=(input,result)=>String(result.grain||input.grain||'month')==='day';

export function salesResultEditFields(capabilityId){return [...(editFields[nameOf(capabilityId)]||[])];}
export function salesCapabilityPresentation(capabilityId){const fields=salesResultEditFields(capabilityId);return fields.length?{resultEditFields:fields}:{};}

function scopeOf(capabilityId,input,result){
 return {module:'sales',capabilityId,period:result.period||input.period,grain:result.grain||input.grain||'month',shop:result.shop||input.shop||'all',...(nameOf(capabilityId)==='freight-report'?{channel:result.channel||input.channel||'all'}:{})};
}
function source(capabilityId,scope,result,fields){
 const data={scope,trend:result.trend,totals:result.totals,...(nameOf(capabilityId)==='report'?{operations:result.operations,reconciliation:result.reconciliation}:{by_shop:result.by_shop,channels:result.channels,legacy_months:result.legacy_months,monthly_unallocated:result.monthly_unallocated})};
 const sha256=agentDigest(data);
 return {id:capabilityId+'.source.'+sha256,title:nameOf(capabilityId)==='report'?'销售台真实经营报告查询':'销售台真实已登记运费查询',kind:'query-result',capabilityId,scope,sha256,fields};
}
const dimension=(input,result)=>({key:'label',label:isDay(input,result)?'日期':'月份'});
const monetary=(key,label)=>({key,label,unit:'分',currency:'CNY'});
const table=(id,title,rows)=>({type:'table',id,title,rowKey:'key',rows:array(rows).map((row,index)=>({...row,key:String(row.key||row.id||[row.shop_id||row.channel||index,row.currency||''].join(':'))}))});

/** Add presentation to real domain query results. No DB access, normalization or new totals. */
export function decorateSalesQuery(capabilityId,input={},result){
 const name=nameOf(capabilityId);if(!plain(result)||!['report','freight-report'].includes(name))return result;
 capabilityId='sales.'+name;const scope=scopeOf(capabilityId,input,result),trend=array(result.trend),blocks=[];
 let evidence;
 if(name==='report'){
  evidence=source(capabilityId,scope,result,['trend.label','trend.sales','trend.refunds','trend.ad_spend','trend.complete','totals.complete','operations','reconciliation']);
  if(trend.length){
   const rows=trend.map(row=>({key:row.label,label:row.label,sales:amount(row.sales),refunds:amount(row.refunds),ad_spend:amount(row.ad_spend)}));
   const complete=result.totals?.complete===true&&trend.every(row=>row.complete===true&&['sales','refunds','ad_spend'].every(key=>amount(row[key])!==null));
   blocks.push({type:'chart',id:'sales.report.trend',title:(isDay(input,result)?'日度':'月度')+'经营趋势（人民币参考折算）',chartType:'line',dimension:dimension(input,result),series:[monetary('sales','销售额'),monetary('refunds','退款额'),monetary('ad_spend','广告费')],rows,sourceRefs:[evidence.id],completeness:{state:complete?'complete':'partial',...(!complete?{message:'保留真实查询中的缺失值；覆盖不足或缺少汇率时不补零。此图不表示利润或实际到账。'}:{})},scope});
  }
  if(Array.isArray(result.operations))blocks.push(table('sales.report.operations','经营统计明细（金额为对应币种整数分；rmb 为参考折算）',result.operations));
  if(Array.isArray(result.reconciliation))blocks.push(table('sales.report.reconciliation','结算与实际收款明细（对应原币整数分，差额不等于利润）',result.reconciliation));
 }else{
  evidence=source(capabilityId,scope,result,['trend.label','trend.shipping','trend.extras','trend.other','trend.total','totals.shipping','totals.packing','totals.materials','totals.storage','totals.other','by_shop','channels']);
  const completeness={state:'partial',message:'仅统计已登记费用，不代表账单完整。未登记保留空值；赔付抵扣以负数显示。'};
  if(trend.length)blocks.push({type:'chart',id:'sales.freight-report.trend',title:(isDay(input,result)?'日度':'月度')+'已登记运费趋势',chartType:'line',dimension:dimension(input,result),series:[monetary('total','费用合计'),monetary('shipping','纯快递运费'),monetary('extras','附加费及抵扣'),monetary('other','其他费用或赔付抵扣')],rows:trend.map(row=>({key:row.label,label:row.label,total:amount(row.total),shipping:amount(row.shipping),extras:amount(row.extras),other:amount(row.other)})),sourceRefs:[evidence.id],completeness:{...completeness},scope});
  if(plain(result.totals))blocks.push({type:'chart',id:'sales.freight-report.fees',title:'本期已登记费用分类（含赔付抵扣）',chartType:'bar',dimension:{key:'fee',label:'费用项目'},series:[monetary('amount','登记金额')],rows:[['shipping','纯快递运费'],['packing','打包费'],['materials','耗材费'],['storage','仓储费'],['other','其他费用或赔付抵扣']].map(([key,fee])=>({key,fee,amount:amount(result.totals[key])})),sourceRefs:[evidence.id],completeness:{...completeness},scope});
  if(Array.isArray(result.by_shop))blocks.push(table('sales.freight-report.by-shop','按店铺及共用归属统计（整数分，不自行分摊）',result.by_shop));
  if(plain(result.channels))blocks.push(table('sales.freight-report.channels','按运费来源统计（整数分）',Object.entries(result.channels).map(([channel,row])=>({channel,...row}))));
 }
 return {...result,scope,blocks:append(result.blocks,blocks),evidence:append(result.evidence,[evidence])};
}

function draftKey(name,input){
 const identity=name.startsWith('ledger-')?{operation:name,id:input.id,shop:input.shop_id,date:input.date,external_id:input.external_id}:{operation:name,id:input.id,shop:input.shop_id||'shared',period:input.period,channel:input.channel,entry_mode:input.entry_mode,bill_no:input.bill_no,tracking_no:input.tracking_no};
 return name+':'+agentDigest(identity);
}

/** Separate editable input cells from read-only domain previews (whose money is cents). */
export function decorateSalesPreparation(capabilityId,input={},result){
 const name=nameOf(capabilityId),allowed=salesResultEditFields(name);if(!plain(result)||!allowed.length)return result;
 const fields=allowed.filter(key=>Object.hasOwn(input,key)),row=Object.fromEntries(fields.map(key=>[key,input[key]]));row.key=draftKey(name,input);
 const draft={type:'table',id:'sales.'+name+'.draft',title:name.startsWith('ledger-')?'可修改的流水草稿（金额为原币元字符串，修改后须重新准备）':'可修改的运费草稿（费用为元字符串，修改后须重新准备）',rowKey:'key',editableFields:fields,rows:[row]};
 return {...result,blocks:append(result.blocks,[draft])};
}
