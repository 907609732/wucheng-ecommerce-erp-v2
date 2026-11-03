import {parsePayrollAmount,payrollRows,isEmptyPayrollDraft as blank,packPayrollGrid,flattenPayrollGrid,emptyPayrollGridRow,emptyPayrollMonthRow} from './payroll-model.mjs';
import {parsePeriod} from './ui/period-picker.mjs';

const fields=['date','name','amount','note'];
const signature=r=>JSON.stringify(fields.map(k=>String(r[k]??'')));
const empty=emptyPayrollGridRow;
export function renderPayrollSheet({root,bills,period,api,esc,money,onChange,onBill,onImport}){
 const annual=/^20\d{2}$/.test(period),year=annual?period:'';
 let initial=payrollRows(bills,period),baseline=new Map(initial.map(r=>[r.key,signature(r)])),saving=false,uncertain=false,discarding=false,pending=null,dead=false,message='';
 let personCount=2;try{const stored=Number(localStorage.getItem('lt.payroll.person-count'));if(Number.isInteger(stored)&&stored>=2&&stored<=20)personCount=stored;}catch{}const packed=packPayrollGrid(initial,personCount,year);personCount=packed.count;
 root.innerHTML=`<section class="payroll-sheet" aria-label="工资在线表格"><div class="payroll-sheet-bar"><div><h2>${annual?"年度工资表":"工资表"} <span>${esc(period)}${annual?"年":""}</span></h2><p>${annual?"1—12 月快速录入 · ":""}一行多人，点击右侧 ＋ 添加人员</p></div><div class="actions">${annual?`<select data-sheet-month aria-label="新增工资行的月份">${Array.from({length:12},(_,i)=>`<option value="${period}-${String(i+1).padStart(2,'0')}" ${i===new Date().getMonth()?'selected':''}>${i+1}月</option>`).join('')}</select>`:""}<button type="button" class="btn" data-sheet="add">＋ ${annual?"追加月内行":"新增行"}</button><button type="button" class="btn" data-sheet="import">导入表格</button><button type="button" class="btn" data-sheet="export">导出 CSV</button><button type="button" class="btn" data-sheet="discard">撤销未保存</button><button type="button" class="btn primary" data-sheet="save">保存修改</button></div></div><div class="payroll-sheet-context"><span>${annual?"所属年度":"所属账期"}：<strong>${esc(period)}</strong></span><label>更正原因 <input data-sheet-reason maxlength="500" placeholder="修改已有记录时填写；新增无需填写"></label><span data-sheet-status role="status" aria-live="polite">正在打开表格…</span></div><div class="payroll-grid" aria-label="应付工资在线表格"></div><div class="payroll-sheet-footer"><span data-sheet-total></span><span>双击或 Enter 编辑 · Tab / 方向键移动 · Ctrl+C / Ctrl+V 复制粘贴</span></div><p class="payroll-sheet-note">${annual?"左侧月份为工资账期。新增工资按对应月末记账，已有记录保留原日期（见明细）。":"日期为账单日期。"}工资金额为应付工资，不代表已经发放。含代扣、公司承担或多人汇总的历史工资，请从“明细 / 付款”进入原账单维护。</p></section>`;
 const status=root.querySelector('[data-sheet-status]'),saveButton=root.querySelector('[data-sheet=save]'),reason=root.querySelector('[data-sheet-reason]');
 const entries=()=>flattenPayrollGrid(grid.getData(),personCount);
 const changed=()=>entries().filter(r=>r.editable&&!blank(r)&&baseline.get(r.key)!==signature(r));
 const dirty=()=>!discarding&&(uncertain||changed().length>0);
 function errors(r){if(blank(r)||!r.editable)return {};const e={};if(!/^20\d{2}-\d{2}-\d{2}$/.test(r.date||'')||!parsePeriod('day',r.date))e.date='请选择有效日期';if(!String(r.name||'').trim()||String(r.name).length>200)e.name='姓名须为1至200字';try{parsePayrollAmount(r.amount);}catch(error){e.amount=error.message;}if(String(r.note||'').length>2000)e.note='备注不能超过2000字';return e;}
 function update(){
  if(dead)return;let total=0,bad=0,count=0;for(const r of entries()){if(blank(r))continue;count++;const e=errors(r);if(Object.keys(e).length)bad++;try{total+=parsePayrollAmount(r.amount);}catch{}const component=grid.getRow(r.gridKey);for(const field of fields){const column=field==='date'?(annual?'month':'date'):'p'+r.slot+'_'+field;const element=component?.getCell(column)?.getElement();if(element){element.classList.toggle('payroll-invalid',!!e[field]);element.title=e[field]||'';element.setAttribute('aria-invalid',String(!!e[field]));}}}
  const changes=changed();root.querySelector('[data-sheet-total]').textContent=`${annual?'12 个月':new Set(entries().map(r=>r.gridKey)).size+' 行'} · ${count} 人次 · 应付工资合计 ¥ ${Number.isSafeInteger(total)?money(total):'合计超出范围'}`;
  status.textContent=message||(changes.length>500?'本次修改超过500人次，请分次录入保存':saving?'正在保存…':uncertain?'保存结果待确认，请点击重试；草稿已保留':bad?`${bad} 人次需要检查，修改尚未保存`:changes.length?`${changes.length} 人次未保存`:'已保存');
  status.dataset.state=uncertain||bad?'error':changes.length?'dirty':'saved';saveButton.textContent=uncertain?'重试确认保存结果':'保存修改';saveButton.disabled=saving||(!uncertain&&(!changes.length||bad>0||changes.length>500));reason.disabled=saving||uncertain;const monthSelect=root.querySelector('[data-sheet-month]');if(monthSelect)monthSelect.disabled=saving||uncertain;
  for(const button of root.querySelectorAll('[data-sheet]'))if(button!==saveButton)button.disabled=saving||uncertain||(button.dataset.sheet==='person'&&personCount>=20);
  onChange?.();
 }
 function personColumns(slot){
  const prefix='p'+slot+'_',canEdit=cell=>!saving&&!uncertain&&cell.getRow().getData()[prefix+'meta']?.editable!==false;
  return {title:'人员 '+(slot+1),columns:[
   {title:'姓名',field:prefix+'name',width:100,editor:'input',editable:canEdit},
   {title:'工资金额',field:prefix+'amount',width:115,hozAlign:'right',editor:'input',editable:canEdit,tooltip:'应付工资，单位：元',formatter:cell=>{try{return money(parsePayrollAmount(cell.getValue()));}catch{return esc(cell.getValue()||'');}}},
   {title:'备注',field:prefix+'note',minWidth:78,widthGrow:1,editor:'input',editable:canEdit},
   {title:'付款状态',field:prefix+'status',width:90,editor:false,formatter:cell=>`<span class="payroll-payment-status">${esc(cell.getValue()||'')}</span>`},
   {title:'明细',field:prefix+'detail',width:80,editor:false,formatter:cell=>{const row=cell.getRow().getData(),meta=row[prefix+'meta'];return meta?.billId?`<button type="button" class="text-button" data-sheet-bill="${esc(meta.billId)}">${meta.complex?'含明细':'明细/付款'}${meta.original?' · 原件':''}</button>`:['name','amount','note'].some(f=>String(row[prefix+f]||'').trim())?`<button type="button" class="text-button" data-sheet-remove="${esc(row.key)}" data-sheet-slot="${slot}">移除</button>`:'';}},
  ]};
 }
 const editableFields=()=>[...(annual?[]:['date']),...Array.from({length:personCount},(_,i)=>['name','amount','note'].map(f=>'p'+i+'_'+f)).flat()];
 const dateEditable=row=>!Object.entries(row).some(([key,value])=>key.endsWith('_meta')&&value?.editable===false);
 function columns(){return [annual?{title:'月份',field:'month',width:90,frozen:true,editor:false,formatter:cell=>Number(cell.getValue().slice(5))+'月',tooltip:cell=>cell.getValue()+' 工资账期'}:{title:'日期',field:'date',width:130,frozen:true,editor:'date',editable:cell=>!saving&&!uncertain&&dateEditable(cell.getRow().getData()),tooltip:'本行所有人员共用的工资账单日期'},...Array.from({length:personCount},(_,i)=>personColumns(i)),{title:'＋',field:'addPerson',width:44,frozen:true,headerSort:false,editor:false,formatter:()=>'',titleFormatter:()=>'<button type="button" data-sheet="person" class="payroll-add-person" aria-label="添加人员" title="点击添加一组人员信息">＋</button>'}];}
 const grid=new Tabulator(root.querySelector('.payroll-grid'),{
  index:'key',data:packed.rows,height:'max(390px, calc(100vh - 440px))',layout:'fitColumns',placeholder:'点击“新增行”开始登记工资',
  selectableRange:1,selectableRangeColumns:true,selectableRangeRows:true,editTriggerEvent:'dblclick',clipboard:true,clipboardCopyStyled:false,clipboardCopyRowRange:'range',clipboardCopyConfig:{rowHeaders:false,columnHeaders:false},
  clipboardPasteParser:text=>text.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(row=>row.split('\t')),
  clipboardPasteAction:function(matrix){
   if(saving||uncertain||!Array.isArray(matrix)||!matrix.length)return [];
   if(matrix.length>500){status.textContent='每次最多粘贴500行';return [];}
   const range=grid.getRanges()[0],startField=range?.getColumns()[0]?.getField()||(annual?'p0_name':'date'),ordered=editableFields(),startColumn=ordered.indexOf(startField);if(startColumn<0){status.textContent=annual?'请从姓名、工资或备注栏开始粘贴':'请选择可编辑单元格';return [];}
   const rows=grid.getRows(),startRow=range?rows.indexOf(range.getRows()[0]):0;if(startRow<0)return [];if(annual&&startRow+matrix.length>rows.length){status.textContent='粘贴超出当前月份行，请先为需要的月份追加行';return [];}
   if(matrix.some(row=>row.length>ordered.length-startColumn)){status.textContent=`粘贴列数超出范围；${annual?'顺序为人员1姓名/工资/备注、人员2姓名/工资/备注…':'顺序为日期、人员1姓名/工资/备注、人员2姓名/工资/备注…'}`;return [];}
   const updates=[];
   for(const [i,cells] of matrix.entries()){
    const r=rows[startRow+i]?.getData()||empty(),patch={...r};
    for(const [j,value] of cells.entries()){
     const field=ordered[startColumn+j],prefix=field.split('_')[0]+'_';
     if(field==='date'?!dateEditable(r):r[prefix+'meta']?.editable===false){status.textContent='粘贴范围包含只读历史明细，请选择空白人员栏';return [];}
     patch[field]=value;
    }
    updates.push(patch);
   }
   message='';void grid.updateOrAddData(updates).then(update);return updates;
  },
  rowHeader:annual?false:{formatter:'rownum',frozen:true,width:40,resizable:false,editor:false,headerSort:false,cssClass:'payroll-row-number'},
  columnDefaults:{headerSort:false,resizable:'header',formatter:'plaintext',editable:false},columns:columns(),
 });
 async function resetData(){const packed=packPayrollGrid(initial,personCount,year);if(packed.count!==personCount){personCount=packed.count;grid.setColumns(columns());}await grid.setData(packed.rows);}
 grid.on('tableBuilt',update);grid.on('cellEdited',()=>{message='';update();});grid.on('dataChanged',()=>queueMicrotask(update));
 async function discard(){if(saving||uncertain)return;discarding=true;await resetData();pending=null;message='';discarding=false;update();}
 async function save(){
  if(saving)return;const rows=changed();if(!uncertain&&(!rows.length||rows.length>500||rows.some(r=>Object.keys(errors(r)).length)))return;
  if(!uncertain){if(rows.some(r=>r.billId)&&!reason.value.trim()){status.textContent='请先填写更正原因，原记录修改会保留审计';reason.focus();return;}pending={requestId:crypto.randomUUID(),...(annual?{year:period}:{month:period}),reason:reason.value.trim(),rows:rows.map(r=>({key:r.key,...(r.billId?{billId:r.billId,version:r.version}:{}),...(annual?{period:r.period}:{}),date:r.date,name:r.name,amount:String(r.amount),note:r.note||''}))};}
  saving=true;message='';update();let confirmed=false;
  try{
   const receipt=await api('/api/payroll/sheet',{method:'POST',body:JSON.stringify(pending)});confirmed=true;
   for(const saved of receipt.saved){const entry=entries().find(r=>r.key===saved.key);if(entry){const prefix='p'+entry.slot+'_',r=grid.getRow(entry.gridKey);await r.update({[prefix+'meta']:{...entry,billId:saved.id,version:saved.version,status:entry.status==='未保存'?'待付款':entry.status},[prefix+'status']:entry.status==='未保存'?'待付款':entry.status});}}
   initial=entries().filter(r=>r.billId).map(r=>structuredClone(r));baseline=new Map(initial.map(r=>[r.key,signature(r)]));pending=null;uncertain=false;reason.value='';
   try{const bills=await api('/api/bills?kind=payroll'+(annual?'':'&period='+period));initial=payrollRows(bills,period);baseline=new Map(initial.map(r=>[r.key,signature(r)]));await resetData();}catch{message='保存已确认，暂未读取到最新列表，可稍后刷新';}
  }catch(error){uncertain=!confirmed&&(!error.status||error.status>=500);if(!uncertain)pending=null;message=error.message;status.dataset.state='error';}
  finally{saving=false;update();if(uncertain)status.textContent='保存结果待确认，点击重试查询同一批次；请勿重复录入';}
 }
 const click=async event=>{
  const b=event.target.closest('button');if(!b||saving||uncertain&&b!==saveButton)return;
  if(b.dataset.sheetBill){if(dirty()){status.textContent='请先保存或撤销表格修改，再打开账单';return;}onBill(b.dataset.sheetBill);return;}
  if(b.dataset.sheetRemove){const r=grid.getRow(b.dataset.sheetRemove),slot=Number(b.dataset.sheetSlot),prefix='p'+slot+'_',data=r.getData();if(data[prefix+'meta']?.billId)return;const patch={[prefix+'meta']:null,...Object.fromEntries(['name','amount','note','status'].map(f=>[prefix+f,'']))};const next={...data,...patch};if(!Object.keys(next).some(k=>/^p\d+_(name|amount|note)$/.test(k)&&String(next[k]||'').trim())&&!Object.entries(next).some(([k,v])=>k.endsWith('_meta')&&v?.billId)){if(annual&&grid.getData().filter(row=>row.month===data.month).length===1)await r.update(patch);else await grid.deleteRow(data.key);}else await r.update(patch);update();return;}
  switch(b.dataset.sheet){
   case 'person':if(personCount>=20)return;{const slot=personCount++;await grid.addColumn(personColumns(slot),true,'addPerson');try{localStorage.setItem('lt.payroll.person-count',String(personCount));}catch{}await grid.scrollToColumn('p'+slot+'_name','left',false);update();break;}
   case 'add':await grid.addRow(annual?emptyPayrollMonthRow(root.querySelector('[data-sheet-month]').value):empty(),false);if(annual)await grid.setSort('month','asc');update();break;
   case 'save':await save();break;
   case 'discard':if(!dirty()||window.confirm('确定撤销本页尚未保存的工资修改？'))await discard();break;
   case 'import':if(dirty()){status.textContent='请先保存或撤销表格修改，再导入';return;}onImport();break;
   case 'export':{const csvCell=v=>{let s=String(v??'');if(/^[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};const rows=grid.getData().filter(r=>flattenPayrollGrid([r],personCount).length),head=[annual?'工资月份':'日期',...Array.from({length:personCount},(_,i)=>['姓名','工资金额（元）','备注','付款状态'].map(label=>'人员'+(i+1)+label)).flat()];const content='\uFEFF'+[head,...rows.map(r=>[annual?r.month:r.date,...Array.from({length:personCount},(_,i)=>['name','amount','note','status'].map(f=>r['p'+i+'_'+f]||'')).flat()])].map(row=>row.map(csvCell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='应付工资-'+period+(dirty()?'-未保存草稿':'')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;}
  }
 };
 root.addEventListener('click',click);
 return {table:grid,dirty:()=>dirty(),isSaving:()=>saving||uncertain,discard,notify:update,destroy(){dead=true;root.removeEventListener('click',click);grid.destroy();}};
}
