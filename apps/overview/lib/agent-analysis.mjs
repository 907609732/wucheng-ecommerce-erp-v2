const categories=[['refund','销售退款'],['platformFee','平台费用'],['purchase','采购实付'],['freight','运费实付'],['payroll','人力实付'],['other','其他实付']];
export function expenseTrendBlocks(result){
 const evidenceId='overview:dashboard:'+result.period+':'+result.revision,sourceRefs=[evidenceId];
 const rows=(result.trend||[]).map(point=>{const row={period:point.period,status:point.status};for(const[key]of categories)row[key]=typeof point.totals?.[key]==='number'?-point.totals[key]:null;row.referenceDifference=typeof point.income==='number'&&categories.every(([key])=>row[key]!==null)?point.income-categories.reduce((n,[key])=>n+row[key],0):null;return row;});
 const completeness={state:result.unavailable?'unavailable':result.complete?'complete':'partial',missingPeriods:rows.filter(r=>categories.some(([key])=>r[key]===null)).map(r=>r.period),note:'未取得或未核实的数据保留null；部分记录不代表整月完整。'};
 const common={type:'chart',chartType:'line',dimension:{key:'period',label:result.grain==='year'?'业务月份':'业务日期'},unit:'分',currency:'CNY',rows,sourceRefs,completeness,scope:{module:'overview',grain:result.grain,period:result.period}};
 return {chartBlocks:[{...common,id:'overview-expense-trend',title:'已录支出趋势（实付口径）',series:categories.map(([key,label])=>({key,label}))},{...common,id:'overview-reference-difference',title:'已录收支参考差额（非利润）',series:[{key:'referenceDifference',label:'收支参考差额（非利润）'}],description:result.definitions}],chartEvidence:[{id:evidenceId,module:'overview',capabilityId:'overview.dashboard',input:{grain:result.grain,period:result.period},revision:result.revision,sourceVersions:result.sourceVersions,description:result.definitions}]};
}

export const draftEditFields={
 'bill-create':['billNo','party','period','billDate','category','owner','title','note','amountCents'],
 'payment-create':['date','direction','amountCents','reference','component','note']
};
export function editableDraftBlock(operation,input){const fields=draftEditFields[operation];if(!fields)return null;return {type:'table',id:'overview-'+operation+'-draft',title:operation==='bill-create'?'新费用账单草稿':'新付款登记草稿',rowKey:'key',editableFields:fields,rows:[{...input,key:'draft'}],description:'仅修改本次新单据草稿；修改后必须重新准备并复核，不直接更改历史账本。'};}
