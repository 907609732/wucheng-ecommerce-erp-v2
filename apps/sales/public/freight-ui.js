import {openWarehouseImportAssistant} from './warehouse-import-assistant.js';
const channels={warehouse:'云仓发货',merchant:'商家寄件',sf:'顺丰快递'};
const modes={month:'按月汇总',day:'按日汇总',single:'单笔寄件'};
const fees={shipping:'快递运费',packing:'打包费',materials:'耗材费',storage:'仓储费',other:'其他费用'};
const colors=['#4676e8','#33a891','#eea844'];

export function createFreightUI(ctx) {
  const {$,esc,money,api,boot,state,dialog,closeDialog,toast,render,addChart,addTable}=ctx;
  let channel='all',page=1,showVoided=false,lastFilter='';
  const shopLabel=r=>r.shop_id?`${r.platform} · ${r.shop}`:'多店共用';
  const params=()=>new URLSearchParams({period:state.period,grain:state.grain,shop:state.shop,channel,status:showVoided?'all':'active'});
  const amount=n=>n==null?'尚未录入':'¥ '+money(n);
  const attachmentLinks=items=>items.map(a=>`<div class="freight-attachment"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.filename)}</a><span>${(a.size/1024).toFixed(0)} KB</span><a href="${esc(a.url)}?download=1">下载</a></div>`).join('');

  async function dashboard(valid) {
    const key=new URLSearchParams({period:state.period,grain:state.grain,shop:state.shop,channel,status:showVoided?'all':'active'}).toString();
    if(key!==lastFilter){page=1;lastFilter=key;}
    const [r,list]=await Promise.all([api('/api/freight/report?'+params()),api('/api/freight/records?'+params()+'&page='+page)]);
    if(!valid())return;
    if(page>1&&!list.rows.length){page--;return render();}
    $('#lock-status').textContent=r.locked?'已锁定':r.totals.count?'已登记 · 待核对':'尚未录入';$('#lock-status').className='pill '+(r.locked?'good':'');
    $('#freight-channel').value=channel;
    $('#freight-channel').onchange=e=>{channel=e.target.value;render();};
    const card=(label,summary,c,note)=>`<button type="button" class="overview-kpi freight-kpi ${channel===c?'is-selected':''}" data-freight-filter="${c}" aria-label="查看${label}明细"><span>${label}</span><strong class="${summary.total==null?'no-data':''}">${amount(summary.total)}</strong><small>${note}</small></button>`;
    $('#content').innerHTML=`<div class="freight-dashboard funds-overview" data-freight-ui>
      <div class="overview-intro"><div><h2>发货费用看板</h2><p>${esc(state.period)} · 仅统计已登记费用 · 金额单位：元</p></div><div class="actions"><span class="freight-indicator">共用费用单独核算</span><button type="button" class="button primary" id="warehouse-import-assistant">开始导入运费</button></div></div>
      <div class="overview-notice">${state.shop==='all'?'云仓与共用顺丰单独列示，不分摊到店铺。':state.shop==='shared'?'当前仅展示多店共用的云仓与顺丰费用。':'当前仅统计该店直接归属的费用，共用云仓及共用顺丰未分摊。'} 本台账独立统计，未参与资金对账扣费。</div>
      ${r.legacy_months.length?`<p class="notice warning">${esc(r.legacy_months.join('、'))} 的锁定快照当时未记录运费。</p>`:''}
      ${r.monthly_unallocated?.count?`<p class="notice warning">本月另有 ${r.monthly_unallocated.count} 条月汇总，共 ${amount(r.monthly_unallocated.total)}，无法确定每天金额，未计入当前日视图。切换“月”查看合计。</p>`:''}
      <div class="overview-kpis">${card('发货费用合计',r.totals,'all','含快递运费及云仓附加费用')}${card('云仓费用',r.channels.warehouse,'warehouse','多店共用 · 含已填写附加费用')}${card('商家寄件费用',r.channels.merchant,'merchant','各店商家寄件费用')}${card('顺丰费用',r.channels.sf,'sf','包含单店与共用顺丰')}</div>
      <div class="overview-secondary"><span>纯快递运费 <strong>${amount(r.totals.shipping)}</strong></span><span>云仓附加费用 <strong>${amount(r.totals.extras)}</strong></span><span>已登记 <strong>${r.totals.count} 条</strong></span><span>发货件数 <strong>${r.totals.pieces??'未完整填写'}</strong></span><span>平均快递运费 <strong>${r.totals.average==null?'—':amount(r.totals.average)+' / 件'}</strong></span></div>
      <div class="overview-charts"><section class="card"><div class="card-head"><h2>费用趋势</h2><span class="subtext">${state.grain==='day'?'本月每日 · 不含月汇总':state.grain==='year'?'本年各月':'最近 12 个月'}</span></div>${r.trend.some(t=>t.total!=null)?'<div class="overview-chart"><canvas id="freight-trend" role="img" aria-label="运费趋势"></canvas></div>':'<div class="freight-empty-chart"><strong>还没有费用记录</strong><p>点击右上角“开始导入运费”，选择平台后交给 AI 导入。</p></div>'}</section>
      <section class="card"><div class="card-head"><h2>费用类型占比</h2></div>${Object.values(r.channels).some(t=>t.total>0)?'<div class="overview-chart"><canvas id="freight-share" role="img" aria-label="运费类型占比"></canvas></div>':'<div class="freight-empty-chart"><strong>暂无可展示的占比</strong><p>登记费用后自动生成。</p></div>'}</section></div>
      <section class="card"><div class="card-head"><h2>各店与共用费用</h2><span class="subtext">点击归属筛选明细</span></div><div class="table-wrap"><table class="simple-table freight-shops"><thead><tr><th>归属</th><th>纯快递运费</th><th>附加费用</th><th>费用合计</th><th>记录条数</th></tr></thead><tbody>${r.by_shop.map(s=>`<tr><td><button class="text-button" data-freight-shop="${esc(s.shop_id)}">${s.shop_id==='shared'?'多店共用':esc(s.platform+' · '+s.shop)}</button>${s.shop_id==='shared'?'<small>未分摊至各店</small>':''}</td><td>${amount(s.shipping)}</td><td>${amount(s.extras)}</td><td><strong>${amount(s.total)}</strong></td><td>${s.count||'—'}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card freight-records"><div class="card-head"><div><h2>录入明细</h2><p class="subtext">${channels[channel]||'全部类型'} · ${list.count} 条${showVoided?'（含作废，作废不计入汇总）':''}</p></div><label class="checkline"><input type="checkbox" id="freight-show-void" ${showVoided?'checked':''}>显示作废记录</label></div><div id="freight-record-table"></div><div class="freight-pagination"><span>第 ${page} / ${Math.max(1,Math.ceil(list.count/list.page_size))} 页 · 每页 ${list.page_size} 条</span><div><button class="button small" id="freight-prev" ${page===1?'disabled':''}>上一页</button><button class="button small" id="freight-next" ${page*list.page_size>=list.count?'disabled':''}>下一页</button></div></div></section>
      <p class="section-note">记录条数不是包裹数。件数未完整填写时不计算平均运费；未登记的店铺和期间不视为零费用。</p></div>`;
    $('#warehouse-import-assistant').onclick=()=>openWarehouseImportAssistant({$,esc,dialog,toast,state,boot});
    document.querySelectorAll('[data-freight-filter]').forEach(b=>b.onclick=()=>{channel=b.dataset.freightFilter;render();});
    document.querySelectorAll('[data-freight-shop]').forEach(b=>b.onclick=()=>{state.shop=b.dataset.freightShop;$('#shop').value=state.shop;render();});
    $('#freight-show-void').onchange=e=>{showVoided=e.target.checked;render();};
    $('#freight-prev').onclick=()=>{page--;render();};$('#freight-next').onclick=()=>{page++;render();};
    const chartOptions={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{beginAtZero:true}}};
    if($('#freight-trend'))addChart(new Chart($('#freight-trend'),{type:'bar',data:{labels:r.trend.map(t=>t.label),datasets:[{label:'费用合计（元）',data:r.trend.map(t=>t.total==null?null:t.total/100),backgroundColor:'#5d84e6',borderRadius:4,maxBarThickness:38}]},options:chartOptions}));
    if($('#freight-share'))addChart(new Chart($('#freight-share'),{type:'doughnut',data:{labels:Object.values(channels),datasets:[{data:Object.keys(channels).map(c=>(r.channels[c].total||0)/100),backgroundColor:colors,borderWidth:3}]},options:{responsive:true,maintainAspectRatio:false,cutout:'73%',plugins:{legend:{position:'bottom',labels:{boxWidth:10,padding:18}}}}}));
    const t=new Tabulator('#freight-record-table',{data:list.rows,layout:'fitDataStretch',placeholder:'暂无账单，点击右上角“开始导入运费”',height:list.rows.length?Math.min(520,100+list.rows.length*50):130,columns:[
      {title:'期间',field:'period',width:120},{title:'录入方式',field:'mode_label',width:110},{title:'费用类型',field:'channel_label',width:110},
      {title:'归属',field:'shop',width:210,formatter:c=>esc(shopLabel(c.getRow().getData()))},
      {title:'合计（元）',field:'total',hozAlign:'right',width:130,formatter:c=>money(c.getValue())},
      {title:'件数',field:'pieces',width:80,formatter:c=>c.getValue()??'—'},
      {title:'状态',field:'status',width:100,formatter:c=>c.getValue()==='void'?'已作废':c.getRow().getData().locked?'已锁定':'有效'},
      {title:'凭证',field:'attachments',width:80,formatter:c=>c.getValue().length+' 个'},
      {title:'操作',field:'id',headerSort:false,width:90,formatter:c=>`<button type="button" class="text-button" data-record-view="${esc(c.getValue())}">查看</button>`,cellClick:(e,c)=>{if(e.target.closest('button'))openDetail(c.getValue());}},
      {title:'备注',field:'note',formatter:'plaintext',minWidth:200}
    ].map(c=>({formatter:'plaintext',...c}))});addTable(t);
  }

  async function openDetail(recordId) {
    try{
      const r=await api('/api/freight/records/'+recordId);
      dialog('运费记录',`<div data-freight-ui><div class="freight-detail-total"><span>${esc(r.channel_label)} · ${esc(r.period)}</span><strong>${amount(r.total)}</strong><p>${esc(shopLabel(r))} · ${esc(r.mode_label)} · ${r.status==='void'?'已作废':r.locked?'已锁定':'有效'}</p></div>
        <dl class="freight-detail-fields">${Object.entries(fees).map(([k,l])=>`<dt>${l}</dt><dd>${amount(r[k])}</dd>`).join('')}<dt>件数</dt><dd>${r.pieces??'未填写'}</dd><dt>账单号</dt><dd>${esc(r.bill_no)||'未填写'}</dd><dt>运单号</dt><dd>${esc(r.tracking_no)||'未填写'}</dd><dt>其他费用说明</dt><dd>${esc(r.other_note)||'—'}</dd><dt>备注</dt><dd>${esc(r.note)||'—'}</dd>${r.status==='void'?`<dt>作废原因</dt><dd>${esc(r.void_reason)}</dd>`:''}</dl>
        <h3>凭证附件</h3>${r.attachments.length?attachmentLinks(r.attachments):'<p class="section-note">未附凭证</p>'}${r.attachment_history.length?`<details class="freight-extra"><summary>历史附件（已移除，原件留存）</summary>${attachmentLinks(r.attachment_history)}</details>`:''}
        </div>`);
      $('#dialog').classList.add('freight-dialog');
    }catch(e){toast(e.message);}
  }

  return {dashboard,canClose:()=>true};
}
