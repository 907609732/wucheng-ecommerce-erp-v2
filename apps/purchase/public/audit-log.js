import {auditActions,auditFields,auditValue,auditText} from './audit-values.mjs';
import {orderConfirmation} from './month-locks.js';
export function createAuditUI(ctx){
 const {state,api,esc,modal,closeModal,setKind,getKind,refresh,render,toast}=ctx;
 const blank=()=>({q:'',action:'changes',platform:'',from:'',to:'',orderId:'',batchId:'',page:1,pageSize:50});
 let filters=blank(),generation=0;
 const time=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 const brief=(value,max=100)=>{const s=String(value);return s.length>max?s.slice(0,max)+'…':s;};
 const diffTable=changes=>`<div class="table-wrap"><table class="data-table audit-diff"><thead><tr><th>修改字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody>${changes.map(c=>`<tr><th>${esc(c.label)}</th><td>${esc(auditText(c.key,c.before))}</td><td>${esc(auditText(c.key,c.after))}</td></tr>`).join('')}</tbody></table></div>`;
 async function page(){
  const root=document.querySelector('#page-content');
  if(!state.auditAvailable){root.innerHTML='<div class="notice">日志与撤销功能需要新版后台。请重启灵兔采购台并刷新页面。</div>';return;}
  root.innerHTML=`<p><a href="#settings">← 返回设置</a></p><section class="panel audit-panel"><form id="audit-filters" class="audit-filters"><label class="field audit-search">搜索日志<input name="q" aria-label="搜索日志" placeholder="订单号、供应商、修改内容、批次或日志编号" value="${esc(filters.q)}"></label><label class="field">修改类型<select name="action" aria-label="日志修改类型"><option value="changes" ${filters.action==='changes'?'selected':''}>全部修改</option><option value="all" ${filters.action==='all'?'selected':''}>全部记录（含首次入账）</option>${Object.entries(auditActions).map(([v,label])=>`<option value="${v}" ${filters.action===v?'selected':''}>${label}</option>`).join('')}</select></label><label class="field">开始日期<input name="from" type="date" aria-label="日志开始日期" value="${esc(filters.from)}"></label><label class="field">结束日期<input name="to" type="date" aria-label="日志结束日期" value="${esc(filters.to)}"></label><button class="btn primary" type="submit">查询</button><button class="btn" type="button" id="reset-audit">重置</button></form><div class="audit-scope">${filters.orderId?'已限定单个订单 · ':''}${filters.batchId?'已限定批次 '+esc(filters.batchId)+' · ':''}时间均为北京时间；保存修改时自动生成日志，撤销也会生成新日志。</div><div id="audit-results" aria-live="polite">正在读取日志…</div></section>`;
  root.querySelector('#audit-filters').addEventListener('submit',e=>{e.preventDefault();for(const [key,value] of new FormData(e.currentTarget))filters[key]=value;filters.page=1;void load();});
  root.querySelector('#reset-audit').addEventListener('click',()=>{filters=blank();void page();});
  await load();
 }
 async function load(){
  const revision=++generation,box=document.querySelector('#audit-results');if(!box)return;box.textContent='正在读取日志…';
  try{
   const result=await api('/api/order-logs?'+new URLSearchParams(filters));if(revision!==generation||state.page!=='logs')return;
   const pages=Math.max(1,Math.ceil(result.total/result.pageSize));if(filters.page>pages){filters.page=pages;await load();return;}
   box.innerHTML=`<div class="audit-count">共 ${result.total} 条日志 · 第 ${result.page} / ${pages} 页</div><div class="table-wrap"><table class="data-table audit-table"><thead><tr><th>日志 / 时间</th><th>订单</th><th>操作</th><th>变更摘要</th><th>批次</th><th>查看</th></tr></thead><tbody>${result.entries.map(l=>`<tr><td><b>#${l.id}</b><div class="muted small">${esc(time(l.createdAt))}</div></td><td><span>${esc(l.supplier)}</span><div class="muted small">${esc(l.platform)} · ${esc(l.orderNo)}</div></td><td>${esc(l.actionLabel)}${l.actor?`<div class="muted small">操作人：${esc(l.actor.label||l.actor.login||l.actor.id)}</div>`:''}${l.rollbackOf?`<div class="muted small">撤销 #${l.rollbackOf}</div>`:''}</td><td class="audit-summary">${l.changes.length?l.changes.slice(0,3).map(c=>`${esc(c.label)}：${esc(brief(auditText(c.key,c.before)))} → ${esc(brief(auditText(c.key,c.after)))}`).join('<br>')+(l.changes.length>3?`<br>另 ${l.changes.length-3} 项变更`:''):'首次入账或来源记录'}${l.reason?`<div>原因：${esc(l.reason)}</div>`:''}</td><td>${l.batchId?`<button class="text-button" data-log-batch="${esc(l.batchId)}" title="${esc(l.batchId)}">本批 ${l.batchCount} 条</button>`:'单次操作'}</td><td><button class="btn" data-log-id="${l.id}">查看变更</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">没有符合条件的日志</td></tr>'}</tbody></table></div><div class="audit-pagination"><button class="btn" id="audit-prev" ${result.page<=1?'disabled':''}>上一页</button><span>第 ${result.page} / ${pages} 页</span><button class="btn" id="audit-next" ${result.page>=pages?'disabled':''}>下一页</button></div>`;
   box.querySelectorAll('[data-log-id]').forEach(b=>b.addEventListener('click',()=>void detail(Number(b.dataset.logId))));
   box.querySelectorAll('[data-log-batch]').forEach(b=>b.addEventListener('click',()=>{filters={...blank(),action:'all',batchId:b.dataset.logBatch};void page();}));
   box.querySelector('#audit-prev').addEventListener('click',()=>{filters.page--;void load();});box.querySelector('#audit-next').addEventListener('click',()=>{filters.page++;void load();});
  }catch(e){if(revision===generation&&state.page==='logs')box.innerHTML=`<div class="alert error">${esc(e.message)}</div>`;}
 }
 async function detail(id){
  setKind('audit');
  try{
   const l=await api('/api/order-logs/'+id);if(getKind()!=='audit')return;
   const locked=l.current&&orderConfirmation(l.current,state),canUndo=l.canUndo&&!locked;
   modal('订单修改日志',`#${l.id} · ${l.actionLabel} · ${time(l.createdAt)}`,`<p>${esc(l.after.platform)} · ${esc(l.after.orderNo)} · ${esc(l.after.supplier)}</p>${l.actor?`<p>实际操作者：${esc(l.actor.label||l.actor.login||l.actor.id)} · ${esc(l.actor.channel==='ui'?'人工界面':'AI / 工具')}</p>`:'<p class="small muted">历史记录未提供实际登录操作者。</p>'}${locked?'<div class="notice">当前订单所在月份已确认，日志只读。需先到月度确认取消确认后再撤销。</div>':''}${l.batchId?`<p class="small muted">批次：${esc(l.batchId)}（${l.batchCount} 条记录）</p>`:''}${l.rollbackOf?`<p>本次撤销了日志 #${l.rollbackOf}</p>`:''}${l.reason?`<p>撤销原因：${esc(l.reason)}</p>`:''}${l.changes.length?diffTable(l.changes):'<p class="notice">此日志没有可撤销的订单属性变更，保留用于查阅。</p>'}<details><summary>查看保存后的完整订单信息</summary><dl class="audit-snapshot">${Object.entries(auditFields).map(([key,label])=>`<dt>${esc(label)}</dt><dd>${esc(auditText(key,auditValue(l.after,key)))}</dd>`).join('')}</dl></details><p class="privacy-note">撤销仅恢复这次改动的字段，保留后来对其他字段的修改。相关字段的当前值已变化时，会阻止撤销并提示核对。</p>`,`<button class="btn" data-action="close">关闭</button>${canUndo?`<div class="actions"><button class="btn" id="undo-log">撤销本次修改</button>${l.batchId&&l.batchCount>1?'<button class="btn" id="undo-log-batch">撤销整个批次</button>':''}</div>`:''}`,true);
   document.querySelector('#undo-log')?.addEventListener('click',()=>void undoPreview(id,'entry'));document.querySelector('#undo-log-batch')?.addEventListener('click',()=>void undoPreview(id,'batch'));
  }catch(e){toast(e.message);}
 }
 async function undoPreview(id,scope){
  setKind('audit-preview');
  try{
   const p=await api('/api/order-logs/rollback-preview',{auditId:id,scope});if(getKind()!=='audit-preview')return;
   modal('确认撤销修改',`${p.count} 笔订单 · ${scope==='batch'?'整个批次':'单笔修改'}`,`<div class="notice">${p.canUndo?'请核对以下变化，确认后一次保存；原日志保留，并生成新的撤销日志。':'当前无法撤销，以下原因需先处理；本次未修改任何订单。'}</div>${p.orders.map(o=>`<section class="audit-undo-order"><h3>${esc(o.orderNo)} · ${esc(o.supplier)}</h3>${o.blockedReason?`<div class="alert error">${esc(o.blockedReason)}</div>`:diffTable(o.changes)}</section>`).join('')}${p.canUndo?'<label class="field">撤销原因（选填）<textarea id="rollback-reason" aria-label="撤销原因" rows="2" maxlength="500" placeholder="例如：误把公司订单设为不计入"></textarea></label>':''}<div id="rollback-error" class="alert error" hidden></div>`,`<button class="btn" data-action="close">取消</button>${p.canUndo?`<button class="btn primary" id="confirm-rollback">确认撤销 ${p.count} 笔</button>`:''}`,true);
   document.querySelector('#confirm-rollback')?.addEventListener('click',async e=>{
    const button=e.currentTarget;button.disabled=true;
    try{const r=await api('/api/order-logs/rollback',{auditId:id,scope,versions:p.orders.map(({auditId,orderId,updatedAt})=>({auditId,orderId,updatedAt})),reason:document.querySelector('#rollback-reason').value});closeModal();await refresh();await render();toast(`已撤销 ${r.changed} 笔修改，新的日志已保存`);}catch(error){const box=document.querySelector('#rollback-error');if(box){box.hidden=false;box.textContent=error.message;button.disabled=false;}}
   });
  }catch(e){toast(e.message);}
 }
 async function forOrder(id){closeModal();filters={...blank(),orderId:id,action:'all'};state.page='logs';await render();}
 return {page,detail,forOrder};
}
