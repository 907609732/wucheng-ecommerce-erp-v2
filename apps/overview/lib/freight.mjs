import ExcelJS from 'exceljs';
import {fail,month,CATEGORIES,hash} from './util.mjs';

export function shopLabel(shop,shops=[]){
 const label=shop.name+' · '+shop.platform;
 return shops.filter(s=>s.name===shop.name&&s.platform===shop.platform).length>1?label+' · '+shop.id:label;
}
export function resolveOwner(value,shops){
 const name=String(value||'company').trim();
 if(['company','公司共用'].includes(name))return 'company';
 const exact=shops.find(s=>s.id===name);if(exact)return exact.id;
 const matches=shops.filter(s=>s.name===name||shopLabel(s,shops)===name);
 if(matches.length!==1)throw fail(matches.length?'店铺名称重复，请使用带平台的完整店铺名或店铺编号':'未找到店铺：'+name);
 return matches[0].id;
}
export function freightRows(s,{period,owner='all',q='',allPeriods=false}={}){
 if(period)month(period);const term=String(q).trim().toLowerCase();
 return s.bills().filter(b=>b.kind==='freight'&&!b.voided&&(allPeriods||!period||b.period===period)&&(owner==='all'||b.owner===owner)&&[b.billNo,b.party,b.title].join(' ').toLowerCase().includes(term)).map(b=>({...b,paidCents:s.paid(b.id),pendingCents:b.amountCents-s.paid(b.id)}));
}
export async function freightWorkbook(s,sources,{period,owner='all',q='',allPeriods=false,template=false}={}){
 month(period);if(owner!=='all'&&owner!=='company'&&!sources.shops.some(x=>x.id===owner))throw fail('店铺不存在');
 const w=new ExcelJS.Workbook();w.creator='灵兔经营收支总览';
 const ws=w.addWorksheet('运费维护');
 const headers=['所属月份','店铺','物流公司','账单编号','账单日期','运费用途','说明','行类型','明细编号','明细说明','应付金额','账单累计实付（只读）','账单待付（只读）','备注','关联来源','更正原因','记录ID','记录版本'];
 ws.addRow(headers);ws.columns=headers.map(h=>({width:h==='店铺'?32:h.includes('说明')||h==='备注'?26:h==='记录ID'?40:20}));
 const owners=[{id:'company',name:'公司共用'},...sources.shops.map(x=>({id:x.id,name:shopLabel(x,sources.shops)}))];
 const name=id=>owners.find(s=>s.id===id)?.name||id;
 if(template){
  const date=new Date(Number(period.slice(0,4)),Number(period.slice(5)),0).getDate();
  for(const shop of owners.filter(x=>owner==='all'||x.id===owner))ws.addRow([period,shop.name,'','YF-'+period.replace('-','')+'-'+hash(shop.id).slice(0,8),period+'-'+date,'销售发货','','明细','1','月度运费',null,null,null,'','','','','']);
 }else for(const b of freightRows(s,{period,owner,q,allPeriods})){
  const lines=b.lines.length?b.lines:[{lineNo:'summary',label:b.party,amountCents:b.amountCents}];
  lines.forEach((l,i)=>ws.addRow([b.period,name(b.owner),b.party,b.billNo,b.billDate,CATEGORIES[b.category],b.title,b.lines.length?'明细':'汇总',l.lineNo,l.label,l.amountCents/100,i===0?b.paidCents/100:null,i===0?b.pendingCents/100:null,b.note,b.linkedSource,'',b.id,b.version]));
 }
 ws.views=[{state:'frozen',ySplit:1,xSplit:2}];ws.autoFilter={from:'A1',to:'R'+Math.max(1,ws.rowCount)};
 ws.getRow(1).height=32;ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF155E56'}};
 const shops=w.addWorksheet('店铺与填写说明');shops.addRow(['店铺','店铺编号']);owners.forEach(x=>shops.addRow([x.name,x.id]));shops.getColumn(1).width=90;shops.getColumn(2).width=45;
 const instructions=['蓝色文字为可填写项，灰色列为参考信息或回导标识。按月份和店铺登记，可为不同物流公司分别填账单。','新增行的记录ID、记录版本留空。金额为空的新增行跳过；费用未发生时留空，不自动记零。','同一账单的店铺、月份、物流公司、编号、项目保持一致，多条明细使用不同明细编号；汇总行不与明细重复加计。','回导维护表时保留记录ID和记录版本，修改已有账单须填更正原因。旧版本会被拒绝，请重新导出。','付款参考值不会导入或改写。导入只生成应付账单，实际付款 / 退款在页面单独登记。','删除 Excel 行不会删除或作废账单。需要作废时在页面填写原因，历史和原件保留。','已有账单回导使用“回导维护表”模式；原始物流账单使用“新账单导入”并预览字段映射。','复制一张账单作为新增时清空记录ID和记录版本，并修改所属月份、店铺或账单编号。','不同平台同名店铺须使用带平台的完整名称，也可以填写店铺编号。金额单位为元，最多两位小数。','文件内已关联的采购 / 平台费用继续仅展示，不重复计入经营支出。'];
 instructions.forEach(t=>shops.addRow([t]));
 const validationEnd=Math.max(ws.rowCount+20,100);
 for(let i=2;i<=validationEnd;i++){
  ws.getCell(i,2).dataValidation={type:'list',allowBlank:true,formulae:["'店铺与填写说明'!$A$2:$A$"+(owners.length+1)],showErrorMessage:true,error:'请选择已存在的店铺'};
  ws.getCell(i,6).dataValidation={type:'list',allowBlank:true,formulae:['"进货运输,销售发货,退货运输,云仓服务"']};
  ws.getCell(i,8).dataValidation={type:'list',allowBlank:true,formulae:['"明细,汇总"']};
 }
 for(let i=2;i<=ws.rowCount;i++)for(let c=1;c<=18;c++){
  const cell=ws.getCell(i,c),readonly=[12,13,17,18].includes(c);cell.font={color:{argb:readonly?'FF7D8B84':'FF225F9B'}};
  if(readonly)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F4F2'}};
  if([4,9,17].includes(c))cell.numFmt='@';if([11,12,13].includes(c))cell.numFmt='#,##0.00;[Red]-#,##0.00';
 }
 return w.xlsx.writeBuffer();
}
