const list=value=>Array.isArray(value)?value:[];
const scalar=value=>value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value);
const printable=value=>value===null?'空值':typeof value==='object'?JSON.stringify(value):String(value);
const node=(tag,text='',className='')=>Object.assign(document.createElement(tag),{textContent:String(text),className});
const button=(text,action)=>{const item=node('button',text);item.type='button';item.addEventListener('click',action);return item;};
const fingerprint=result=>result?JSON.stringify([result.id,result.version]):null;

/** Only declaration data is consumed here; result blocks never supply executable chart options or file URLs. */
export function createResultTools({api,getDetail,getStatus,isHistorical,makeTable,onRefresh,onDraftChange=()=>{},notice,showError,loading}){
  const drafts=new Map(),charts=new Set();let resultKey=null,previewEpoch=0,previewUrl=null,previewSource=null,chartModule;
  const dialog=node('dialog','','artifact-dialog');dialog.setAttribute('aria-labelledby','artifact-preview-title');
  const heading=node('h2','原件预览');heading.id='artifact-preview-title';
  const closeButton=button('关闭',()=>dialog.close()),header=node('div','','preview-heading'),metadata=node('div','','preview-metadata'),body=node('div','','preview-body'),actions=node('div','','preview-actions');
  header.append(heading,closeButton);dialog.append(header,metadata,actions,body);document.body.append(dialog);
  function releasePreview(){previewEpoch++;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;body.replaceChildren();}
  dialog.addEventListener('close',()=>{if(dialog.open)return;releasePreview();if(previewSource?.isConnected)previewSource.focus();previewSource=null;});
  function closePreview(){if(dialog.open)dialog.close();releasePreview();}
  function disposeCharts(){for(const item of charts){item.observer.disconnect();item.chart.dispose();}charts.clear();}
  function hasChanges(){return [...drafts.values()].some(draft=>draft.edits.size);}
  function leave({ask=true}={}){if(ask&&hasChanges()&&!window.confirm('有尚未提交的草稿更正。离开会放弃这些更正，是否继续？'))return false;drafts.clear();closePreview();disposeCharts();return true;}
  function renderStart(detail){
    const key=fingerprint(detail?.result);
    if(resultKey!==key&&hasChanges()){
      const summary=[...drafts.values()].flatMap(draft=>[...draft.edits.values()].map(edit=>`${edit.field}：${printable(edit.before)} → ${printable(edit.after)}`)).join('；');
      notice('结果已更新，未提交的更正未应用。请核对新版本后重新更正。原更正：'+summary);
    }
    drafts.clear();resultKey=key;closePreview();disposeCharts();
  }
  async function download(id){try{await api.request('artifacts.open',{taskId:getDetail()?.task?.id,id});}catch(error){showError(error);}}
  async function preview(id,file={},source=document.activeElement){
    closePreview();previewSource=source;const epoch=++previewEpoch,taskId=getDetail()?.task?.id;
    heading.textContent=file.name||file.filename||'原件预览';metadata.replaceChildren();actions.replaceChildren(button('下载',()=>void download(id)));loading(body,'正在读取原件');
    dialog.showModal();closeButton.focus();
    try{
      const response=await api.request('artifacts.preview',{taskId,id});if(epoch!==previewEpoch||taskId!==getDetail()?.task?.id||!dialog.open)return;
      const item=response?.preview,allowed=['image/png','image/jpeg','image/webp','application/pdf'];
      if(!item||!allowed.includes(item.mimeType)||typeof item.bytes!=='string'||item.bytes.length>17*1024*1024||!Number.isSafeInteger(item.size)||item.size<=0||item.size>12*1024*1024||!/^[a-f0-9]{64}$/i.test(item.sha256||''))throw new Error('原件预览信息无效，请刷新任务后重试。');
      const bytes=Uint8Array.from(atob(item.bytes),character=>character.charCodeAt(0));
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
      if(bytes.length!==item.size||digest!==item.sha256.toLowerCase())throw new Error('原件完整性校验失败，请重新取得原件。');
      if(epoch!==previewEpoch||!dialog.open)return;
      previewUrl=URL.createObjectURL(new Blob([bytes],{type:item.mimeType}));heading.textContent=item.name;metadata.append(node('p',`${item.mimeType} · ${(item.size/1024).toFixed(1)} KB`),node('p','SHA-256：'+item.sha256),node('p','来源：'+(file.sourceLabel||file.title||file.name||file.filename||'当前任务已登记原件')));body.replaceChildren();
      if(item.mimeType==='application/pdf'){
        const frame=node('iframe');frame.title=item.name+' PDF 预览';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.src=previewUrl+'#toolbar=1&navpanes=1';body.append(frame,node('p','可使用 PDF 查看器的页码与缩放控件。若当前终端不能显示，请下载查看。','fine-print'));
      }else{
        const viewport=node('div','','preview-image-viewport'),image=node('img');image.src=previewUrl;image.alt=item.name;image.addEventListener('error',()=>{if(epoch===previewEpoch&&dialog.open)body.replaceChildren(node('p','图片无法解码，请下载原件核对。','attention'));});viewport.append(image);body.append(viewport);
        let scale=1;const status=node('span','100%');const zoom=change=>{scale=Math.min(4,Math.max(.25,Math.round((scale+change)*100)/100));image.style.width=(scale*100)+'%';status.textContent=Math.round(scale*100)+'%';};
        actions.append(button('缩小',()=>zoom(-.25)),status,button('放大',()=>zoom(.25)),button('适应窗口',()=>{scale=1;zoom(0);}));
      }
    }catch(error){if(epoch!==previewEpoch||!dialog.open)return;body.replaceChildren(node('p',String(error.message||error),'attention'),node('p','此原件暂无法内嵌预览，可下载后查看。','fine-print'));actions.append(button('重试',()=>void preview(id,file,source)));}
  }
  function fileActions(id,file={}){const wrap=node('span','','file-actions');wrap.append(button('预览',event=>void preview(id,file,event.currentTarget)),button('下载',()=>void download(id)));return wrap;}
  function eligible(block){
    const detail=getDetail(),actor=getStatus()?.actor,cap=list(getStatus()?.capabilities).find(item=>item.module===block.sourceModule&&item.id===block.sourceCapabilityId);
    if(isHistorical()||!detail?.result||detail.result.receipt||list(detail.task?.completedStages).length||!['waiting_review','waiting_input','paused','failed'].includes(detail.task?.status)||!['admin','editor'].includes(actor?.role)||actor.canRunTasks!==true||!block.id||!block.rowKey||!list(actor.modules).includes(block.sourceModule))return [];
    return list(block.editableFields).filter(field=>field!==block.rowKey&&list(cap?.resultEditFields).includes(field));
  }
  function enhanceTable(wrap,block,{rows,columns}){
    const fields=eligible(block),keys=rows.map(row=>row[block.rowKey]);
    if(!fields.length||!rows.length||keys.some(key=>!scalar(key)||key===null)||new Set(keys.map(key=>JSON.stringify(key))).size!==rows.length)return;
    const toolbar=node('div','','draft-toolbar'),editButton=button('更正草稿',start);toolbar.append(editButton);wrap.prepend(toolbar);
    function start(){
      const detail=getDetail(),base={resultId:detail.result.id,resultVersion:detail.result.version},draft={...base,edits:new Map()};drafts.set(block.id,draft);editButton.hidden=true;
      const differences=node('ul','','correction-differences'),message=node('p','更正后将重新生成结果，需重新复核。','fine-print'),save=button('提交更正',()=>void submit()),cancel=button('取消',()=>{drafts.delete(block.id);restore();onDraftChange();});save.disabled=true;
      const inputs=[];let submitting=false;
      rows.forEach((row,rowIndex)=>columns.forEach((column,columnIndex)=>{
        const before=row[column.key];if(!fields.includes(column.key)||!Object.hasOwn(row,column.key)||!scalar(before))return;
        const cell=wrap.querySelectorAll('tbody tr')[rowIndex]?.children[columnIndex];if(!cell)return;
        const editor=node('input');editor.value=before===null?'':String(before);editor.setAttribute('aria-label',`${column.label||column.key}，行 ${printable(row[block.rowKey])}`);editor.dataset.field=column.key;
        if(typeof before==='number'){editor.inputMode=Number.isInteger(before)?'numeric':'decimal';editor.placeholder='按来源单位填写，不自动换算';}else if(typeof before==='boolean')editor.placeholder='true 或 false';
        const original=node('small','原值：'+printable(before),'cell-original');cell.replaceChildren(editor,original);inputs.push({editor,cell,before,column});
        editor.addEventListener('input',()=>{
          let after=editor.value;
          if(typeof before==='number')after=editor.value.trim()===''?null:Number(editor.value);
          if(typeof before==='boolean')after=editor.value==='true'?true:editor.value==='false'?false:undefined;
          const valid=scalar(after)&&after!==undefined;editor.setCustomValidity(valid?'':'请使用原字段类型填写有效值');
          const key=JSON.stringify([row[block.rowKey],column.key]);if(valid&&JSON.stringify(before)!==JSON.stringify(after))draft.edits.set(key,{blockId:block.id,rowKey:row[block.rowKey],field:column.key,before,after});else draft.edits.delete(key);
          differences.replaceChildren(...[...draft.edits.values()].map(item=>node('li',`${item.field}：${printable(item.before)} → ${printable(item.after)}`)));save.disabled=submitting||!draft.edits.size||inputs.some(item=>!item.editor.checkValidity());onDraftChange();
        });
      }));
      toolbar.append(message,differences,save,cancel);inputs[0]?.editor.focus();
      function restore(){for(const item of inputs)item.cell.textContent=printable(item.before);toolbar.replaceChildren(editButton);editButton.hidden=false;editButton.focus();}
      async function submit(){
        if(submitting||!draft.edits.size)return;
        if(isHistorical()||fingerprint(getDetail()?.result)!==JSON.stringify([base.resultId,base.resultVersion])){showError(new Error('结果已更新，请核对新版本后重新更正。'));return;}
        submitting=true;save.disabled=true;cancel.disabled=true;inputs.forEach(item=>item.editor.disabled=true);
        try{await api.request('tasks.input',{taskId:getDetail().task.id,corrections:{...base,edits:[...draft.edits.values()]}});drafts.delete(block.id);onDraftChange();notice('更正已提交，正在重新生成结果。新结果仍需复核。');await onRefresh();}
        catch(error){showError(error);submitting=false;save.disabled=false;cancel.disabled=false;inputs.forEach(item=>item.editor.disabled=false);}
      }
    }
  }
  function chartBlock(block){
    const root=node('div','','chart-result'),details=node('details','','record-details');details.append(node('summary','查看数据'),makeTable({rows:list(block.rows),columns:[block.dimension,...list(block.series)].filter(Boolean)}));
    const valid=['line','bar'].includes(block.chartType)&&typeof block.dimension?.key==='string'&&list(block.series).length>0&&list(block.series).length<=12&&list(block.rows).length<=2000&&list(block.series).every(series=>typeof series.key==='string'&&typeof series.unit==='string');
    const rows=list(block.rows),missing=block.completeness?.state==='missing',references=list(block.sourceRefs),knownSources=new Set(list(getDetail()?.result?.evidence).map(source=>source.id).filter(Boolean));
    if(!valid){root.append(node('p','暂不支持此图表协议，请核对数据明细。','attention'),details);return root;}
    const bad=rows.some(row=>!row||typeof row!=='object'||!Object.hasOwn(row,block.dimension.key)||list(block.series).some(series=>row[series.key]!==null&&row[series.key]!==undefined&&(typeof row[series.key]!=='number'||!Number.isFinite(row[series.key]))));
    const duplicate=new Set(rows.map(row=>String(row?.[block.dimension.key]))).size!==rows.length,sourceMissing=!references.length||references.some(reference=>typeof reference!=='string'||!knownSources.has(reference));
    if(block.scope)root.append(node('p','范围：'+JSON.stringify(block.scope),'fine-print'));
    if(block.completeness?.state!=='complete')root.append(node('p',block.completeness?.message||'数据未齐全，缺失值未按零处理。','attention'));
    root.append(node('p','来源：'+(list(block.sourceRefs).join('、')||'尚未提供来源引用'),'fine-print'));
    if(missing||bad||duplicate||sourceMissing||!rows.length){root.append(node('p',missing?'数据尚未齐全，暂不能生成此图表。':bad?'指标包含非数值，请核对原始单位和数据。':duplicate?'维度存在重复项，请由业务服务核对聚合口径。':sourceMissing?'图表来源尚未登记，请核对数据来源后重新生成。':'此范围没有符合条件的记录。','empty'),details);return root;}
    const groups=new Map();for(const series of block.series){const key=JSON.stringify([series.unit,series.currency||'']);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(series);}
    for(const series of groups.values()){
      const label=series[0].unit+(series[0].currency?' · '+series[0].currency:''),canvas=node('div','','result-chart');canvas.setAttribute('role','img');canvas.setAttribute('aria-label',(block.title||'业务图表')+'，单位 '+label+'，具体数值见下方明细');root.append(node('p','单位：'+label,'fine-print'),canvas);loading(canvas,'正在绘制图表');
      void (chartModule||=import('../../node_modules/echarts/dist/echarts.esm.min.js')).then(echarts=>{
        if(!canvas.isConnected)return;canvas.replaceChildren();const chart=echarts.init(canvas,null,{renderer:'svg'}),observer=new ResizeObserver(()=>chart.resize());observer.observe(canvas);charts.add({chart,observer});
        chart.setOption({animation:false,aria:{enabled:true},tooltip:{trigger:'axis',renderMode:'richText',valueFormatter:value=>value==null?'缺失':String(value)+' '+label},legend:{type:'scroll',data:series.map(item=>item.label||item.key)},grid:{left:64,right:20,top:48,bottom:55,containLabel:true},xAxis:{type:'category',data:rows.map(row=>String(row[block.dimension.key])),name:block.dimension.label||block.dimension.key,axisLabel:{hideOverlap:true}},yAxis:{type:'value',name:label,scale:true},series:series.map(item=>({name:item.label||item.key,type:block.chartType,data:rows.map(row=>row[item.key]??null),connectNulls:false,showSymbol:true,lineStyle:{width:2},itemStyle:{borderRadius:block.chartType==='bar'?[3,3,0,0]:0}}))});
      }).catch(error=>{if(canvas.isConnected)canvas.replaceChildren(node('p','图表暂时无法显示，请查看数据明细。','attention'));});
    }
    root.append(details);return root;
  }
  return {enhanceTable,chartBlock,fileActions,preview,renderStart,leave,closePreview,hasChanges,dispose(){leave({ask:false});dialog.remove();}};
}
