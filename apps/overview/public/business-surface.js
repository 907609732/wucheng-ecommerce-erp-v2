const modules=new Set(['overview','purchase','sales']);
export function controlledLocator(target={}){
 if(!target||typeof target!=='object'||!modules.has(target.module)||Object.keys(target).some(key=>!['module','recordId','sourceId','batchId','period','basis','view'].includes(key)))throw Error('来源定位参数无效');
 const result={module:target.module};for(const key of ['recordId','sourceId','batchId','basis','view'])if(target[key]!=null){if(typeof target[key]!=='string'||target[key].length>500||/[\x00-\x1f]/.test(target[key]))throw Error('来源定位字段无效');result[key]=target[key];}
 for(const key of ['recordId','sourceId','batchId'])if(result[key]!==undefined&&(!result[key]||/[\/\\?#]/.test(result[key])||/^\.{1,2}$/.test(result[key])))throw Error('来源记录标识无效');
 if(result.view!==undefined&&(result.module!=='overview'||!['overview','freight','expenses','payroll','gaps'].includes(result.view)))throw Error('目标页面不在受控白名单');
 if(target.period!=null){if(!/^20\d{2}(-(0[1-9]|1[0-2]))?$/.test(target.period))throw Error('来源期间无效');result.period=target.period;}return result;
}
export function installBusinessSurface({getContext,navigate,isSaving=()=>false}){
 const baselines=new WeakMap();
 const fingerprint=form=>JSON.stringify([...form.querySelectorAll('input,textarea,select')].map(element=>({name:element.name||element.dataset.line||'',type:element.type,value:element.type==='file'?[...element.files].map(file=>[file.name,file.size,file.lastModified]):element.type==='checkbox'||element.type==='radio'?element.checked:element.value})));
 const remember=form=>{if(form)baselines.set(form,fingerprint(form));};
 const forms=()=>[...document.querySelectorAll('dialog form')];
 const dirty=form=>form.id!=='source-search-form'&&baselines.has(form)&&baselines.get(form)!==fingerprint(form);
 const getDraftState=()=>{const openForms=forms().map(form=>({id:form.id,kind:form.dataset.kind||form.id,recordId:form.dataset.id||null,open:!!form.closest('dialog')?.open,dirty:dirty(form)}));return {dirty:openForms.some(row=>row.dirty),busy:isSaving(),canSave:false,persistence:'memory-only',openForms};};
 const notify=()=>window.dispatchEvent(new CustomEvent('wucheng-business-state',{detail:{protocolVersion:1,module:'overview',context:getContext(),draft:getDraftState()}}));
 const discard=()=>{for(const form of forms().filter(dirty)){const dialog=form.closest('dialog');form.remove();dialog?.close();}notify();};
 const surface=Object.freeze({protocolVersion:1,module:'overview',getContext:()=>structuredClone(getContext()),getDraftState,navigate:async(target,options={})=>{const locator=controlledLocator(target),draft=getDraftState();if(draft.busy)return {status:'blocked',reason:'save-in-progress',draft};if(draft.dirty&&options.discardDraft!==true)return {status:'blocked',reason:'unsaved-draft',draft};if(draft.dirty&&options.discardDraft===true)discard();if(locator.module!=='overview'){window.dispatchEvent(new CustomEvent('wucheng-business-navigate',{detail:locator}));return {status:'host-navigation-required',target:locator};}const result=await navigate(locator);notify();return result;}});
 window.wuchengBusinessSurface=surface;
 document.addEventListener('input',notify);document.addEventListener('change',notify);document.addEventListener('click',()=>queueMicrotask(notify));
 window.addEventListener('beforeunload',event=>{if(getDraftState().dirty){event.preventDefault();event.returnValue='';}});
 return {surface,remember,rememberAll:()=>forms().forEach(remember),dirty,notify,discard};
}
