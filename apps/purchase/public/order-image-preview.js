// Tabulator renders only part of a page. Load previews as their cells enter view.
export function createOrderImagePreview({api,esc,openDetail}){
 const entries=new Map(),roots=new Map(),visible=new Set(),queue=[],queued=new Set();
 let enabled=false,disposed=false,active=0;
 const observer=new IntersectionObserver(changes=>{
  for(const change of changes){const root=change.target,id=roots.get(root);if(!id)continue;
   if(change.isIntersecting){visible.add(root);enqueue(id);}else visible.delete(root);
  }
 });
 const entryFor=id=>{if(!entries.has(id))entries.set(id,{images:[],warnings:[],loaded:false,loading:false,error:''});return entries.get(id);};
 function inView(id){return [...visible].some(root=>root.isConnected&&roots.get(root)===id);}
 function paint(id){
  const entry=entryFor(id),images=entry.images.slice(0,3),ready=images.filter(i=>i.status==='ready');
  for(const [root,orderId] of roots){
   if(!root.isConnected){observer.unobserve(root);roots.delete(root);visible.delete(root);continue;}
   if(orderId!==id)continue;
   if(ready.length){
    const review=entry.images.some(i=>i.needsReview),caption=`${entry.images.length} 张${review?' · 待核对':''}`;
    root.innerHTML=`<button class="order-preview-button" type="button" aria-label="查看订单图片，共 ${entry.images.length} 张" title="点击查看全部图片"><span class="order-preview-strip ${ready.length>1?'multiple':''}">${ready.map(image=>`<img src="${esc(image.thumbUrl)}" alt="订单图片" loading="lazy">`).join('')}</span><span class="order-preview-caption ${review?'needs-review':''}">${caption}</span></button>`;
   }else if(entry.error||entry.loaded&&entry.images.length){
    root.innerHTML='<button class="order-preview-button order-preview-empty" type="button">图片加载失败<br><small>点此查看详情重试</small></button>';
   }else if(entry.loaded){root.innerHTML=`<span class="order-preview-empty">${entry.warnings.length?'图片来源待核对':'暂无图片'}</span>`;}
   else root.innerHTML='<span class="order-preview-empty" role="status">正在加载图片…</span>';
  }
 }
 function enqueue(id){
  if(!enabled||disposed||!inView(id))return;
  const entry=entryFor(id);if(entry.loaded||entry.loading||queued.has(id))return;
  queue.push(id);queued.add(id);pump();
 }
 function pump(){
  while(enabled&&!disposed&&active<2&&queue.length){
   const id=queue.shift();queued.delete(id);if(!inView(id))continue;
   const entry=entryFor(id);if(entry.loaded||entry.loading)continue;
   active++;entry.loading=true;
   void (async()=>{
    try{
     const result=await api(`/api/orders/${id}/images/prepare`,{});entry.images=result.images;entry.warnings=result.warnings;
     for(const image of result.images.slice(0,3)){
      if(disposed||!enabled||!inView(id))return;
      if(image.status==='ready')continue;
      try{const cached=await api(`/api/orders/${id}/images/${image.id}/cache`,{});entry.images=cached.images;}
      catch(e){const failed=entry.images.find(i=>i.id===image.id);if(failed){failed.status='failed';failed.error=e.message;}}
      if(!disposed)paint(id);
     }
     entry.loaded=true;
    }catch(e){entry.error=e.message;entry.loaded=true;}
    finally{active--;entry.loading=false;if(!disposed){paint(id);enqueue(id);pump();}}
   })();
  }
 }
 function formatter(cell,params,onRendered){
  const id=cell.getData().id,root=document.createElement('div');root.className='order-preview';
  root.innerHTML='<span class="order-preview-empty">等待加载图片</span>';
  root.addEventListener('click',event=>{if(event.target.closest('button')){event.stopPropagation();openDetail(id);}});
  onRendered(()=>{if(disposed)return;roots.set(root,id);paint(id);if(enabled)observer.observe(root);});return root;
 }
 function setEnabled(value){
  enabled=value;observer.disconnect();visible.clear();queue.length=0;queued.clear();
  if(enabled)for(const root of roots.keys())if(root.isConnected)observer.observe(root);
 }
 function dispose(){disposed=true;setEnabled(false);roots.clear();entries.clear();}
 return {formatter,setEnabled,dispose};
}
