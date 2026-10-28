import {classificationForm,classificationDraft} from './classification-ui.js';
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yuan=n=>n==null?'未知':'¥'+(n/100).toFixed(2);
const labels={date:'下单日期',paidAt:'付款日期',supplier:'供应商',status:'状态',amountCents:'整单实付',refundCents:'退款金额',shippingCents:'运费（已含在实付）',recipient:'收货人',phone:'电话',address:'地址',logisticsCompany:'物流公司',trackingNo:'运单号',note:'备注',items:'商品明细',classification:'采购分类'};
let nonce='',current=null,step=1,busy=false;
async function api(route,method='GET',body){
  const r=await fetch('/api/integration/v1'+route,{method,headers:{'Content-Type':'application/json','x-review-token':nonce},...(body?{body:JSON.stringify(body)}:{})}),data=await r.json();
  if(!r.ok)throw Error(data.error||'请求失败');return data;
}
function display(key,value){
  if(key==='items')return (value||[]).map(i=>`${esc(i.title)} · ${esc(i.spec||'')} × ${esc(i.qty??i.quantity)} · 单价 ${yuan(i.unitPriceCents??i.unitPriceFen)}`).join('<br>');
  if(key.endsWith('Cents'))return yuan(value);
  if(typeof value==='object')return esc(JSON.stringify(value));return esc(value)||'<span class="muted">未提供</span>';
}
async function action(fn){if(busy)return;busy=true;$('#message').textContent='';document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){$('#message').textContent=e.message;}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
async function list(){
  const {batches}=await api('/transfers');
  $('#content').innerHTML=`<h2>采集后，在导出台点击“导入采购台”</h2><p>每次导入整个任务。请先完成所选范围的列表采集；关键字段及退款核实后才能入账。</p><h3>最近导入批次</h3>${batches.length?batches.map(b=>`<p><button data-batch="${esc(b.id)}">${esc(new Date(b.created_at).toLocaleString('zh-CN'))} · ${esc(({draft:'待明细核对',reviewed:'待最终确认',committed:'已校验入账',rolled_back:'已撤销'})[b.state]||b.state)}</button></p>`).join(''):'<p class="muted">还没有收到采集结果。</p>'}`;
}
async function load(id){current=await api('/transfers/'+id);step=1;history.replaceState(null,'','?batch='+encodeURIComponent(id));render();}
function render(){
  const p=current;
  if(p.state==='committed'||p.state==='rolled_back'){
    const r=p.result;
    $('#content').innerHTML=`<h2>${r?.verified?'入账完成，校验通过':r?.recoveryRequired?'校验有差异，需要处理':'本批已撤销'}</h2><p class="${r?.verified?'success':'error'}">${r?.verified?'已逐单核对明细和金额，并完成提交后复核。':esc(r?.reason||'未保留本批变动')}</p>${metrics(r?.summary||p.total)}<p>原始采集快照及核对记录已保留。</p><p class="muted">采集范围：${esc(p.task.from)} 至 ${esc(p.task.to)} · ${esc(p.platform)} · ${esc(p.account)}</p><table><thead><tr><th>订单</th><th>处理结果</th></tr></thead><tbody>${(r?.orders||[]).map(o=>`<tr><td>${esc(o.orderNo)}</td><td>${esc(o.reason)}</td></tr>`).join('')}</tbody></table><div class="toolbar"><a href="/">查看采购台</a><button id="verify">再次检查本批数据</button>${p.state==='committed'?'<button id="rollback">撤销本批</button>':''}</div><div id="verification"></div>`;return;
  }
  const blocks=[...p.errors,...p.rows.flatMap(r=>r.issues.map(i=>`${r.orderNo}：${i}`))];
  $('#content').innerHTML=`<div class="steps"><span class="${step===1?'active-step':''}">1 · 明细确认</span><span>→</span><span class="${step===2?'active-step':''}">2 · 整批确认</span><span>→ 校验结果</span></div><h2>${esc(p.platform)} · ${esc(p.task.from)} 至 ${esc(p.task.to)}</h2><p>${p.total.orders} 笔订单 · 保留全部商品行 · ${esc(p.task.listOutcome==='complete'?'列表范围已完成':'列表范围尚未完成')}</p>${step===1?detailHtml(p,blocks):summaryHtml(p)}`;
}
function metrics(t){return `<div class="metrics"><div>新增 / 更新 / 跳过<strong>${t.new} / ${t.update} / ${t.skip}</strong></div><div>采集 / 拟入账商品明细<strong>${t.sourceItems??t.items} / ${t.items} 行</strong></div><div>本批实付净变化<strong>${yuan(t.deltaPaidCents)}</strong></div><div>采购净支出变化<strong>${yuan(t.deltaNetCents)}</strong></div></div>`;}
function detailHtml(p,blocks){
  return `<label>对应采购账号<input id="account" list="accounts" value="${esc(p.account)}" placeholder="填写真实账号"><datalist id="accounts">${p.accounts.map(x=>`<option value="${esc(x)}"></option>`).join('')}</datalist></label><p class="muted">请确认此账号就是采集任务所用账号。不同账号不会合并订单。</p>${blocks.length?`<details class="error" open><summary>整批暂不能入账：${blocks.length} 项待处理</summary>${blocks.map(x=>`<p>${esc(x)}</p>`).join('')}</details>`:'<p class="success">关键字段检查通过，请逐单核对来源与拟入账内容。</p>'}
  ${p.rows.map((r,index)=>`<details class="order-row" data-index="${index}" ${r.issues.length?'open':''}><summary>${esc(r.orderNo)} · ${esc(r.source.shop)} · ${yuan(r.source.paidFen)} · ${{new:'新增',update:'更新',skip:'跳过'}[r.action]} ${r.issues.length?' · 需处理':''}</summary>
  ${r.warnings.length?`<p class="warning">${r.warnings.map(esc).join('；')}</p>`:''}
  ${r.refundUnknown?`<label>核实退款（元）<input data-refund="${index}" type="number" min="0" step="0.01" value="${r.decision.refundCents==null?'':(r.decision.refundCents/100).toFixed(2)}" placeholder="无退款填写 0"></label><label>核对依据<input data-evidence="${index}" value="${esc(r.decision.refundEvidence||'')}" placeholder="例如：已核对平台售后记录"></label>`:''}
  <div class="table-wrap"><table><thead><tr><th>字段</th><th>原始采集 / 转换值</th><th>采购台原值</th><th>拟入账内容</th><th>确认选择</th></tr></thead><tbody>${Object.entries(labels).filter(([k])=>k!=='classification').map(([key,label])=>{
    const diff=r.differences.find(d=>d.field===key),raw={amountCents:r.source.paidFen,refundCents:r.source.refundFen,shippingCents:r.source.freightFen,items:r.source.items};
    const value=Object.hasOwn(raw,key)?raw[key]:r.normalized?.[key];
    const proposed=key==='shippingCents'&&r.source.freightFen==null&&!r.existing?'未获取；不另加运费':display(key,r.proposed?.[key]);
    return `<tr><td>${label}</td><td>${display(key,value)}</td><td>${display(key,r.existing?.[key])}</td><td>${proposed}</td><td>${diff?`<select data-field="${key}" data-row="${index}"><option value="">请选择</option><option value="keep" ${diff.choice==='keep'?'selected':''}>保留原值</option><option value="source" ${diff.choice==='source'?'selected':''}>采用采集值</option></select>`:'—'}</td></tr>`;
  }).join('')}</tbody></table></div>
  <div data-classification="${index}">${classificationForm({...r.proposed,amountCents:r.proposed?.amountCents??r.source.paidFen,classification:r.decision.classification||r.existing?.classification||r.proposed?.classification})}</div>
  <details><summary>查看原始采集字段</summary><pre>${esc(JSON.stringify(r.source,null,2))}</pre></details></details>`).join('')}
  <div class="sticky toolbar"><button id="save">保存核对内容并重新检查</button><button id="first-confirm" class="primary">第一次确认：明细已核对 →</button></div>`;
}
function summaryHtml(p){return `${metrics(p.total)}<table><thead><tr><th>金额</th><th>采集 / 核实</th><th>本批所涉原记录</th><th>拟入账（含跳过项）</th><th>入账变化</th></tr></thead><tbody>
  <tr><th>实付</th><td>${yuan(p.total.sourcePaidCents)}</td><td>${yuan(p.total.beforePaidCents)}</td><td>${yuan(p.total.proposedPaidCents)}</td><td>${yuan(p.total.deltaPaidCents)}</td></tr>
  <tr><th>退款</th><td>${yuan(p.total.sourceRefundCents)}</td><td>${yuan(p.total.beforeRefundCents)}</td><td>${yuan(p.total.proposedRefundCents)}</td><td>${yuan(p.total.deltaRefundCents)}</td></tr>
  <tr><th>净支出</th><td>${yuan(p.total.sourceNetCents)}</td><td>${yuan(p.total.beforeNetCents)}</td><td>${yuan(p.total.proposedNetCents)}</td><td>${yuan(p.total.deltaNetCents)}</td></tr>
  </tbody></table><p class="warning">请再次对照平台确认。金额相等只代表转换和入账一致，不能证明平台没有漏单。</p><p>本批 ${p.total.orders} 笔订单中，新增 ${p.total.new} 笔、更新 ${p.total.update} 笔、重复或保留原值 ${p.total.skip} 笔。原始商品行完整留存，拟入账明细按第一次确认的选择处理。</p><label><input id="final-check" type="checkbox">我已核对本批数量、金额和变更内容</label><div class="sticky toolbar"><button id="back">返回明细修改</button><button id="commit" class="primary">第二次确认并入账</button></div>`;}
function decisions(){
  const rows={};current.rows.forEach((r,index)=>{
    const row={...r.decision,fields:{...r.decision.fields}};
    document.querySelectorAll(`[data-row="${index}"]`).forEach(el=>{row.fields[el.dataset.field]=el.value;});
    const refund=$(`[data-refund="${index}"]`),evidence=$(`[data-evidence="${index}"]`),classification=$(`[data-classification="${index}"]`);
    if(refund){if(refund.value==='')delete row.refundCents;else {if(!/^\d+(?:\.\d{1,2})?$/.test(refund.value))throw Error('退款金额最多两位小数');row.refundCents=Math.round(Number(refund.value)*100);}row.refundEvidence=evidence.value.trim();}
    if(classification)row.classification=classificationDraft(classification);
    rows[r.orderNo]=row;
  });return {account:$('#account').value.trim(),rows};
}
async function save(){current=await api('/transfers/'+current.id,'PUT',{revision:current.revision,decisions:decisions()});render();}
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  action(async()=>{
    if(b.dataset.batch)return load(b.dataset.batch);
    if(b.id==='launch'){if(window.workbenchTransport){location.assign('/apps/exporter/');return;}await (window.lingtuShell?window.lingtuShell.open('exporter'):api('/exporter/open','POST',{}));$('#message').textContent='订单导出台已打开；采集完成后点击其中的“导入采购台”。';return;}
    if(b.id==='save')return save();
    if(b.id==='first-confirm'){await save();if(!current.canConfirm)throw Error('请先处理全部待核对项目');current=await api(`/transfers/${current.id}/review`,'POST',{revision:current.revision});step=2;render();}
    if(b.id==='back'){step=1;render();}
    if(b.id==='commit'){if(!$('#final-check').checked)throw Error('请勾选确认本批数量、金额和变更内容');const {receipt}=await api(`/transfers/${current.id}/confirm`,'POST',{revision:current.revision});await api(`/transfers/${current.id}/commit`,'POST',{receipt});await window.lingtuShell?.dataChanged();await load(current.id);}
    if(b.id==='verify'){const v=await api(`/transfers/${current.id}/verification`);$('#verification').innerHTML=v.differences.length?`<p class="error">${v.differences.map(x=>esc(x.orderNo+'：'+x.reason)).join('<br>')}</p>`:'<p class="success">本批订单当前数据与确认结果一致。</p>';}
    if(b.id==='rollback'){const reason=prompt('撤销只影响本批新增与更新。请填写撤销原因：');if(!reason)return;await api(`/transfers/${current.id}/rollback`,'POST',{reason});await load(current.id);}
  });
});
document.addEventListener('change',e=>{if(e.target.name==='classificationMode'){const root=e.target.closest('.classification-form'),mixed=e.target.value==='split';root.querySelector('.classification-parts').hidden=!mixed;root.querySelector('.class-single-hint').hidden=mixed;}});
try{nonce=(await(await fetch('/api/integration/v1/review-session')).json()).nonce;if(!nonce)throw Error('核对会话建立失败，请刷新页面');const params=new URL(location.href).searchParams,id=params.get('batch');if(id)await load(id);else await list();if(params.get('launch')==='1'&&window.workbenchTransport)location.assign('/apps/exporter/');else if(params.get('launch')==='1')await (window.lingtuShell?window.lingtuShell.open('exporter'):api('/exporter/open','POST',{}));}catch(e){$('#message').textContent=e.message;}
