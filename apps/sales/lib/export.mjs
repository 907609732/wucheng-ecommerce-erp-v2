import ExcelJS from 'exceljs';
import {Chart,registerables} from 'chart.js';
import {createCanvas,GlobalFonts} from '@napi-rs/canvas';
import {existsSync} from 'node:fs';
import {report,monthData} from './report.mjs';
import {SHOPS,KINDS,DATASETS} from './config.mjs';
import {pddFundsReport} from './pdd.mjs';
import {movementRows,aggregateMovements} from './pdd-services.mjs';
import {hash} from './util.mjs';
Chart.register(...registerables);
export async function exportPddMovements(s,q,readRows=movementRows){
  const data=readRows(s,q),totals=aggregateMovements(data.rows),wb=new ExcelJS.Workbook();wb.creator='灵兔电商销售台';
  table(wb,'筛选与合计',['项目','值'],[['店铺',data.unassigned?'待归属账单':s.shops().find(x=>x.id===q.shop_id)?.name],['开始日期',data.from],['结束日期',data.to],['订单号搜索',q.q||''],['收支方向',q.direction||'全部'],['分类',q.category||'全部'],['原件',q.batch_id||'全部'],['笔数',totals.count],['收入（元）',totals.income/100],['支出（元）',totals.expense/100],['净变动（元）',totals.net/100]],[24,65]);
  const ws=table(wb,'逐笔明细',['发生时间','订单号','收入（元）','支出（元）','业务分类','原始账务类型','业务代码','原始业务描述','原始备注','来源文件','原件行号','流水ID'],data.rows.map(r=>[r.occurred_at,String(r.order_no),r.amount>0?r.amount/100:0,r.amount<0?r.amount/100:0,r.category_label,r.original_type,r.business_code,r.category,r.original_note,r.filename,r.source_row,r.id]),[24,30,18,18,20,20,16,50,65,60,14,42]);ws.getColumn(2).numFmt='@';ws.getColumn(3).numFmt='#,##0.00';ws.getColumn(4).numFmt='#,##0.00';return Buffer.from(await wb.xlsx.writeBuffer());
}
if(existsSync('C:/Windows/Fonts/msyh.ttc'))GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','Microsoft YaHei');
const val=n=>n==null?'未取得':n/100;
function table(wb,name,headers,rows,widths=[]) {
  const ws=wb.addWorksheet(name,{views:[{state:'frozen',ySplit:1}],properties:{defaultRowHeight:24}});
  ws.addRow(headers);for(const r of rows)ws.addRow(r);
  ws.columns=headers.map((h,i)=>({width:widths[i]||18}));
  ws.getRow(1).font={name:'Microsoft YaHei',size:11,bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF174B43'}};ws.getRow(1).height=32;
  ws.eachRow((row,i)=>{if(i>1){row.font={name:'Microsoft YaHei',size:10};if(i%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F6F4'}};}row.alignment={vertical:'middle',wrapText:true};});
  if(rows.length)ws.autoFilter={from:'A1',to:{row:rows.length+1,column:headers.length}};
  ws.pageSetup={orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0};return ws;
}
export async function exportWorkbook(s,query) {
  const r=report(s,query),wb=new ExcelJS.Workbook();wb.creator='灵兔电商销售台';wb.created=new Date();
  const ws=table(wb,'总览',['灵兔电商销售台',r.period,'状态',r.locked?'已锁定':'草稿（待核对）'],[
    ['指标','金额 / 数量','说明',''],
    ['已取得支付金额（人民币参考）',val(r.totals.sales),r.totals.complete?'所选范围已核对完整':'数据不完整，不代表全店总额',''],
    ['已取得退款金额（人民币参考）',val(r.totals.refunds),'按退款发生日期',''],
    ['已取得广告消耗（人民币参考）',val(r.totals.ad_spend),'不含充值',''],
    ['支付订单数',r.totals.orders??'未取得','缺失未补零',''],
    ['净收入范围',r.exclusions,'',''],
    ['统计口径',r.definitions,'',''],
    ['报表类型','截至导出时的数据快照','更正后请从销售台重新导出',''],
  ],[34,32,58,24]);
  ws.getColumn(2).numFmt='#,##0.00';ws.mergeCells('B7:D7');ws.getRow(7).height=42;ws.mergeCells('B8:D8');ws.getRow(8).height=42;
  const canvas=createCanvas(1050,360),ctx=canvas.getContext('2d');
  const chart=new Chart(ctx,{type:'line',data:{labels:r.trend.map(p=>p.label),datasets:[{label:'已取得支付金额（人民币参考）',data:r.trend.map(p=>p.sales==null?null:p.sales/100),borderColor:'#217c6e',backgroundColor:'#217c6e',spanGaps:false,tension:.2}]},options:{responsive:false,animation:false,font:{family:'Microsoft YaHei'},plugins:{legend:{labels:{font:{family:'Microsoft YaHei'}}}},scales:{y:{beginAtZero:true},x:{ticks:{font:{family:'Microsoft YaHei'}}}}}});
  const png=canvas.toBuffer('image/png');chart.destroy();const image=wb.addImage({buffer:png,extension:'png'});ws.addImage(image,{tl:{col:0,row:11},ext:{width:1050,height:360}});
  const ops=table(wb,'各店运营',['平台','店铺','原币','支付金额','订单数','退款金额','广告消耗','归因成交额','期间访客','期间买家','客单价','转化率','投产比','核对状态','来源口径'],r.operations.map(o=>[o.platform,o.shop,o.currency,val(o.sales),o.orders??'未取得',val(o.refunds),val(o.ad_spend),val(o.ad_sales),o.visitors??'不可累加 / 未取得',o.buyers??'未取得',val(o.aov),o.conversion??'未取得',o.roas??'未取得',o.coverage==='full'?'已核对':'未完整核对',o.definition]),[12,27,10,18,15,18,18,18,22,18,16,16,16,20,60]);
  for(const c of [4,6,7,8,11])ops.getColumn(c).numFmt='#,##0.00';ops.getColumn(12).numFmt='0.00%';ops.getColumn(13).numFmt='0.00';
  const recon=table(wb,'各店对账',['平台','店铺','原币','净结算','实际收款','另付单店费用','平台已扣费用（仅展示）','净收入','当期时间差额（非错账）','累计结算未匹配','累计收款未匹配','线下代发应收余额'],r.reconciliation.map(o=>[o.platform,o.shop,o.currency,val(o.settlement),val(o.receipt),val(o.expense),val(o.already_deducted),val(o.net_income),val(o.cash_gap),val(o.unmatched_settlement),val(o.unmatched_receipt),val(o.receivable)]),[12,27,10,18,18,22,28,18,30,24,24,24]);for(let i=4;i<=12;i++)recon.getColumn(i).numFmt='#,##0.00';
  table(wb,'趋势',['日期','已取得支付金额（人民币参考）','退款（人民币参考）','数据完整'],r.trend.map(p=>[p.label,val(p.sales),val(p.refunds),p.complete?'是':'否']),[20,36,32,16]);
  for(const pddShop of s.shops().filter(x=>x.platform==='拼多多'&&(!query.shop||query.shop==='all'||x.id===query.shop))) {
    const funds=pddFundsReport(s,query.period,query.grain||'month',pddShop.id);
    if(funds.count){
      const suffix=s.shops().filter(x=>x.platform==='拼多多').length>1?'-'+pddShop.name.replace(/[\x00-\x1f\\/*?:\[\]]/g,'').slice(0,8)+'-'+hash(pddShop.id).slice(0,5):'';
      const fw=table(wb,'拼多多货款动账'+suffix,[pddShop.name+'货款账户',query.period,'说明',''],[
        ['流入（元）',funds.income/100,'含订单收入、优惠券及其他动账',''],['流出（元）',-funds.expense/100,'含退款、费用、营销转账和提现',''],['净变动（元）',(funds.income+funds.expense)/100,'不代表净利润、运营销售额或银行到账',''],['记录笔数',funds.count,'只包含所属店铺已确认归属的记录，完整度见销售台',''],
      ],[30,24,62,20]);
      const cv=createCanvas(950,350),ch=new Chart(cv.getContext('2d'),{type:'line',data:{labels:funds.daily.map(x=>x.date),datasets:[{label:'流入',data:funds.daily.map(x=>x.income==null?null:x.income/100),borderColor:'#217b68'},{label:'流出',data:funds.daily.map(x=>x.expense==null?null:-x.expense/100),borderColor:'#c29c58'}]},options:{responsive:false,animation:false,scales:{y:{beginAtZero:true}}}});
      const img=wb.addImage({buffer:cv.toBuffer('image/png'),extension:'png'});ch.destroy();fw.addImage(img,{tl:{col:0,row:7},ext:{width:950,height:350}});
      table(wb,'拼多多动账分类'+suffix,['官方业务描述','笔数','流入（元）','流出（元）'],funds.groups.map(g=>[g.category,g.count,g.income/100,Math.abs(g.expense)/100]),[65,15,22,22]);
      table(wb,'拼多多动账趋势'+suffix,['日期','流入（元）','流出（元）','净变动（元）'],funds.daily.map(d=>[d.date,val(d.income),d.expense==null?'未取得':Math.abs(d.expense)/100,val(d.net)]),[20,22,22,22]);
    }
  }
  if(query.grain!=='year') {
    const data=monthData(s,query.period.slice(0,7)),start=query.grain==='day'?query.period:query.period+'-01',end=query.grain==='day'?query.period:r.end;
    const records=data.ledger.filter(l=>(query.shop==='all'||!query.shop||l.shop_id===query.shop)&&l.date>=start&&l.date<=end);
    table(wb,'流水原值',['店铺','日期','类型','币种','金额','业务编号','结算批次','关联销售','费用项目','已扣','来源','导入批次','备注'],records.map(l=>[s.shops().find(x=>x.id===l.shop_id)?.name,l.date,KINDS[l.kind],l.currency,l.amount/100,l.external_id,l.match_key,l.order_ref,l.category,l.deducted?'是':'否',l.source,l.batch_id||'手工',l.note]),[27,16,18,10,18,30,26,26,22,10,25,40,50]);
    table(wb,'覆盖与来源',['店铺','数据集','月份','状态','核对依据'],data.coverage.map(c=>[s.shops().find(x=>x.id===c.shop_id)?.name,DATASETS[c.dataset],c.month,c.status,c.evidence]),[27,18,16,16,65]);
    table(wb,'参考汇率',['日期','原币','1 原币折人民币','生效日期','来源','原文 SHA256'],data.rates.filter(x=>x.date>=start&&x.date<=end).map(f=>[f.date,f.currency,f.rate/1e8,f.effective_date,f.source,f.sha256]),[16,12,24,16,70,68]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
