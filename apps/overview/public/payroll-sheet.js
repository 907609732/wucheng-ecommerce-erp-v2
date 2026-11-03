import {parsePayrollAmount,payrollRows,isEmptyPayrollDraft as blank} from './payroll-model.mjs';
import {parsePeriod} from './ui/period-picker.mjs';

const fields=['date','name','amount','note'];
const signature=r=>JSON.stringify(fields.map(k=>String(r[k]??'')));
const empty=()=>({key:crypto.randomUUID(),date:'',name:'',amount:'',note:'',editable:true,status:'未保存'});
export function renderPayrollSheet({root,bills,period,api,esc,money,onChange,onBill,onImport}){
 let initial=payrollRows(bills,period),baseline=new Map(initial.map(r=>[r.key,signature(r)])),saving=false,uncertain=false,discarding=false,pending=null,dead=false,message='';
 root.innerHTML=`<section class="payroll-sheet" aria-label="工资在线表格"><div class="payroll-sheet-bar"><div><h2>工资表 <span>${esc(period)}</span></h2><p>每人一行 · 先登记应付，实际付款另行记录</p></div><div class="actions"><button type="button" class="btn" data-sheet="add">＋ 新增行</button><button type="button" class="btn" data-sheet="import">导入表格</button><button type="button" class="btn" data-sheet="export">导出 CSV</button><button type="button" class="btn" data-sheet="discard">撤销未保存</button><button type="button" class="btn primary" data-sheet="save">保存修改</button></div></div><div class="payroll-sheet-context"><span>所属账期：<strong>${esc(period)}</strong></span><label>更正原因 <input data-sheet-reason maxlength="500" placeholder="修改已有记录时填写；新增无需填写"></label><span data-sheet-status role="status" aria-live="polite">正在打开表格…</span></div><div class="payroll-grid" aria-label="应付工资在线表格"></div><div class="payroll-sheet-footer"><span data-sheet-total></span><span>双击或 Enter 编辑 · Tab / 方向键移动 · Ctrl+C / Ctrl+V 复制粘贴</span></div><p class="payroll-sheet-note">日期为账单日期，工资金额为应付工资，不代表已经发放。含代扣、公司承担或多人汇总的历史工资，请从“明细 / 付款”进入原账单维护。</p></section>`;
 const status=root.querySelector('[data-sheet-status]'),saveButton=root.querySelector('[data-sheet=save]'),reason=root.querySelector('[data-sheet-reason]');
 const changed=()=>grid.getData().filter(r=>r.editable&&!blank(r)&&baseline.get(r.key)!==signature(r));
 const dirty=()=>!discarding&&(uncertain||changed().length>0);
 function errors(r){if(blank(r)||!r.editable)return {};const e={};if(!/^20\d{2}-\d{2}-\d{2}$/.test(r.date||'')||!parsePeriod('day',r.date))e.date='请选择有效日期';if(!String(r.name||'').trim()||String(r.name).length>200)e.name='姓名须为1至200字';try{parsePayrollAmount(r.amount);}catch(error){e.amount=error.message;}if(String(r.note||'').length>2000)e.note='备注不能超过2000字';return e;}
 function update(){
  if(dead)return;let total=0,bad=0,count=0;for(const r of grid.getData()){if(blank(r))continue;count++;const e=errors(r);if(Object.keys(e).length)bad++;try{total+=parsePayrollAmount(r.amount);}catch{}const component=grid.getRow(r.key);for(const field of fields){const element=component?.getCell(field)?.getElement();if(element){element.classList.toggle('payroll-invalid',!!e[field]);element.title=e[field]||'';element.setAttribute('aria-invalid',String(!!e[field]));}}}
  const changes=changed();root.querySelector('[data-sheet-total]').textContent=`${count} 行 · 应付工资合计 ¥ ${Number.isSafeInteger(total)?money(total):'合计超出范围'}`;
  status.textContent=message||(saving?'正在保存…':uncertain?'保存结果待确认，请点击重试；草稿已保留':bad?`${bad} 行需要检查，修改尚未保存`:changes.length?`${changes.length} 行未保存`:'已保存');
  status.dataset.state=uncertain||bad?'error':changes.length?'dirty':'saved';saveButton.textContent=uncertain?'重试确认保存结果':'保存修改';saveButton.disabled=saving||(!uncertain&&(!changes.length||bad>0));reason.disabled=saving||uncertain;
  for(const button of root.querySelectorAll('[data-sheet]'))if(button!==saveButton)button.disabled=saving||uncertain;
  onChange?.();
 }
 const grid=new Tabulator(root.querySelector('.payroll-grid'),{
  index:'key',data:initial.length?structuredClone(initial):[empty(),empty(),empty()],height:'max(390px, calc(100vh - 440px))',layout:'fitColumns',placeholder:'点击“新增行”开始登记工资',
  selectableRange:1,selectableRangeColumns:true,selectableRangeRows:true,editTriggerEvent:'dblclick',clipboard:true,clipboardCopyStyled:false,clipboardCopyRowRange:'range',clipboardCopyConfig:{rowHeaders:false,columnHeaders:false},
  clipboardPasteParser:text=>text.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(row=>row.split('\t')),
  clipboardPasteAction:function(matrix){
   if(saving||uncertain||!Array.isArray(matrix)||!matrix.length)return [];
   if(matrix.length>500){status.textContent='每次最多粘贴500行';return [];}
   const range=grid.getRanges()[0],startField=range?.getColumns()[0]?.getField()||'date',startColumn=fields.indexOf(startField);if(startColumn<0)return [];
   const rows=grid.getRows(),startRow=range?rows.indexOf(range.getRows()[0]):0;if(startRow<0)return [];
   if(matrix.some((_,i)=>rows[startRow+i]&&!rows[startRow+i].getData().editable)){status.textContent='粘贴范围包含只读历史明细，请选择空白行';return [];}
   if(matrix.some(row=>row.length>fields.length-startColumn)){status.textContent='粘贴列数超出可编辑范围，请按日期、姓名、工资金额、备注排列';return [];}
   const updates=matrix.map((cells,i)=>{const r=rows[startRow+i]?.getData()||empty();const patch={...r};cells.forEach((v,j)=>patch[fields[startColumn+j]]=v);return patch;});
   void grid.updateOrAddData(updates).then(update);return updates;
  },
  rowHeader:{formatter:'rownum',frozen:true,width:44,resizable:false,editor:false,headerSort:false,cssClass:'payroll-row-number'},
  columnDefaults:{headerSort:false,resizable:'header',formatter:'plaintext',editable:cell=>cell.getRow().getData().editable&&!saving&&!uncertain},
  columns:[
   {title:'日期',field:'date',width:150,editor:'date',tooltip:'工资账单日期，实际付款另外登记'},
   {title:'姓名',field:'name',width:160,editor:'input'},
   {title:'工资金额（元）',field:'amount',width:175,hozAlign:'right',editor:'input',formatter:cell=>{try{return money(parsePayrollAmount(cell.getValue()));}catch{return esc(cell.getValue()||'');}}},
   {title:'付款状态',field:'status',width:115,editor:false,editable:false,formatter:cell=>`<span class="payroll-payment-status">${esc(cell.getValue())}</span>`},
   {title:'备注',field:'note',minWidth:180,editor:'input'},
   {title:'凭证 / 明细',field:'complex',width:145,editor:false,editable:false,formatter:cell=>{const r=cell.getRow().getData();return r.billId?`<button type="button" class="text-button" data-sheet-bill="${esc(r.billId)}">${r.complex?'含工资明细':'明细 / 付款'}${r.original?' · 原件':''}</button>`:`<button type="button" class="text-button" data-sheet-remove="${esc(r.key)}">移除空行 / 草稿</button>`;}},
  ],
 });
 grid.on('tableBuilt',update);grid.on('cellEdited',()=>{message='';update();});grid.on('dataChanged',()=>queueMicrotask(update));
 async function discard(){if(saving||uncertain)return;discarding=true;await grid.setData(initial.length?structuredClone(initial):[empty(),empty(),empty()]);pending=null;message='';discarding=false;update();}
 async function save(){
  if(saving)return;const rows=changed();if(!uncertain&&(!rows.length||rows.some(r=>Object.keys(errors(r)).length)))return;
  if(!uncertain){if(rows.some(r=>r.billId)&&!reason.value.trim()){status.textContent='请先填写更正原因，原记录修改会保留审计';reason.focus();return;}pending={requestId:crypto.randomUUID(),month:period,reason:reason.value.trim(),rows:rows.map(r=>({key:r.key,...(r.billId?{billId:r.billId,version:r.version}:{}),date:r.date,name:r.name,amount:String(r.amount),note:r.note||''}))};}
  saving=true;message='';update();let confirmed=false;
  try{
   const receipt=await api('/api/payroll/sheet',{method:'POST',body:JSON.stringify(pending)});confirmed=true;
   for(const saved of receipt.saved){const r=grid.getRow(saved.key);if(r)await r.update({billId:saved.id,version:saved.version,status:r.getData().status==='未保存'?'待付款':r.getData().status});}
   initial=grid.getData().filter(r=>r.billId).map(r=>structuredClone(r));baseline=new Map(initial.map(r=>[r.key,signature(r)]));pending=null;uncertain=false;reason.value='';
   try{const bills=await api('/api/bills?kind=payroll&period='+period);initial=payrollRows(bills,period);baseline=new Map(initial.map(r=>[r.key,signature(r)]));await grid.setData(initial.length?structuredClone(initial):[empty()]);}catch{message='保存已确认，暂未读取到最新列表，可稍后刷新';}
  }catch(error){uncertain=!confirmed&&(!error.status||error.status>=500);if(!uncertain)pending=null;message=error.message;status.dataset.state='error';}
  finally{saving=false;update();if(uncertain)status.textContent='保存结果待确认，点击重试查询同一批次；请勿重复录入';}
 }
 const click=async event=>{
  const b=event.target.closest('button');if(!b||saving||uncertain&&b!==saveButton)return;
  if(b.dataset.sheetBill){if(dirty()){status.textContent='请先保存或撤销表格修改，再打开账单';return;}onBill(b.dataset.sheetBill);return;}
  if(b.dataset.sheetRemove){await grid.deleteRow(b.dataset.sheetRemove);update();return;}
  switch(b.dataset.sheet){
   case 'add':await grid.addRow(empty(),false);update();break;
   case 'save':await save();break;
   case 'discard':if(!dirty()||window.confirm('确定撤销本页尚未保存的工资修改？'))await discard();break;
   case 'import':if(dirty()){status.textContent='请先保存或撤销表格修改，再导入';return;}onImport();break;
   case 'export':{const csvCell=v=>{let s=String(v??'');if(/^[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};const rows=grid.getData().filter(r=>!blank(r));const content='\uFEFF'+[['日期','姓名','工资金额（元）','付款状态','备注'],...rows.map(r=>[r.date,r.name,r.amount,r.status,r.note])].map(row=>row.map(csvCell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='应付工资-'+period+(dirty()?'-未保存草稿':'')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;}
  }
 };
 root.addEventListener('click',click);
 return {table:grid,dirty:()=>dirty(),isSaving:()=>saving||uncertain,discard,notify:update,destroy(){dead=true;root.removeEventListener('click',click);grid.destroy();}};
}
