import {payrollYearSummary} from './payroll-model.mjs';
import {applyChartDefaults,themeColor} from './ui/chart-theme.mjs';

export function renderPayrollDashboard({root,bills,year,esc,money}){
 const data=payrollYearSummary(bills,year),hasPayments=data.months.some(m=>m.paidCents!==null);
 const card=(label,value,caption)=>`<section class="payroll-kpi"><span>${label}</span><strong>${value}</strong><small>${caption}</small></section>`;
 root.innerHTML=`<section class="payroll-dashboard" aria-label="年度人力支出看板">
  <div class="payroll-dashboard-heading"><div><span class="payroll-eyebrow">PEOPLE & PAYROLL</span><h2>${esc(year)} 年人力支出</h2><p>全年费用与付款进度，一眼看清。</p></div><a class="btn primary" href="#payroll" data-view="payroll">去工资表填写 ↗</a></div>
  <div class="payroll-kpis">
   ${card('年度应付人力费用',money(data.billCount?data.payableCents:null),'按工资账期 · 含公司承担')}
   ${card('年度实际净付款',money(hasPayments?data.paidCents:null),'按付款日期 · 已扣除退款')}
   ${card('本年账单当前待付',money(data.billCount?data.pendingCents:null),'本年账单截至目前的未付余额')}
   ${card('已录工资月份',data.recordedMonths+'<em>/ 12</em>',data.billCount+' 张账单 · '+data.partyCount+' 个收款对象')}
  </div>
  <section class="card payroll-trend"><div class="card-head"><div><h2>全年人力费用趋势</h2><p class="subtle">工资应付按账期，实际付款按发生月 · 单位：元</p></div><span class="pill gray">1—12 月</span></div><div class="payroll-chart-frame"><canvas role="img" aria-label="${esc(year)}年每月人力应付和实际净付款图，完整数据见下方表格"></canvas></div>${!data.billCount&&!hasPayments?'<div class="payroll-dashboard-empty">今年还没有已录的人力支出，去工资表填写后将在这里展示。</div>':''}</section>
  <section class="card"><div class="card-head"><h2>各月费用明细</h2><small>未录入的月份保留为空，不视为零费用</small></div><div class="table-wrap"><table class="simple payroll-month-summary"><thead><tr><th>月份</th><th class="number">应付人力费用</th><th class="number">实际净付款</th><th class="number">账单当前待付</th><th>录入情况</th></tr></thead><tbody>${data.months.map(m=>`<tr><td>${esc(m.label)}</td><td class="number">${money(m.payableCents)}</td><td class="number">${money(m.paidCents)}</td><td class="number">${money(m.billCount?m.pendingCents:null)}</td><td><span class="pill ${m.billCount?'good':'gray'}">${m.billCount?m.billCount+' 张账单':'未录工资'}</span></td></tr>`).join('')}</tbody></table></div></section>
  <p class="payroll-dashboard-definition">应付费用按账单应付总额统计，包含公司承担，代扣不重复相加。实际净付款包含本年支付的往年工资，不包含其他年份的付款。待付按本年度账单的全部有效付款计算；未录入不代表无费用。</p>
 </section>`;
 applyChartDefaults(Chart,Number(getComputedStyle(document.documentElement).getPropertyValue('--font-scale'))||1);
 const chart=new Chart(root.querySelector('canvas'),{
  type:'bar',data:{labels:data.months.map(m=>m.label),datasets:[
   {label:'应付人力费用',data:data.months.map(m=>m.payableCents===null?null:m.payableCents/100),backgroundColor:themeColor('--lt-brand'),borderRadius:4,maxBarThickness:24},
   {label:'实际净付款',data:data.months.map(m=>m.paidCents===null?null:m.paidCents/100),backgroundColor:themeColor('--lt-chart-2'),borderRadius:4,maxBarThickness:24}
  ]},options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{usePointStyle:true,boxWidth:8,padding:22}},tooltip:{callbacks:{label:c=>c.dataset.label+'：¥ '+money(Math.round(c.parsed.y*100))}}},scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:themeColor('--lt-line')},ticks:{callback:n=>new Intl.NumberFormat('zh-CN',{notation:Math.abs(n)>=10000?'compact':'standard'}).format(n)}}}}
 });
 return {destroy(){chart.destroy();}};
}
