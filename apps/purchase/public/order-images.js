export function createOrderImageUI({api,esc}){
 let current=null,lightbox=null;
 const sources=image=>image.bindings.map(b=>`${b.filename} · ${b.sheet} 第 ${b.row} 行`).filter((v,i,a)=>a.indexOf(v)===i).join('；');
 const label=image=>[...new Set(image.bindings.map(b=>`${image.needsReview||b.itemIndex==null?'原表图片':'商品 '+(b.itemIndex+1)}${b.title?' · '+b.title:''}`))].join('；');
 function closeLightbox(){if(lightbox){lightbox.close();lightbox.remove();lightbox=null;}}
 function dispose(){current=null;closeLightbox();}
 function open(imageId){
  if(!current)return;const ready=current.images.filter(i=>i.status==='ready');let index=ready.findIndex(i=>i.id===imageId);if(index<0)return;
  closeLightbox();lightbox=document.createElement('dialog');lightbox.className='image-lightbox';lightbox.setAttribute('aria-label','查看订单图片');
  const paint=()=>{const image=ready[index];lightbox.innerHTML=`<header><strong>订单图片 ${index+1} / ${ready.length}</strong><button type="button" class="btn" data-image-close aria-label="关闭大图">关闭</button></header><div class="image-full"><img src="${esc(image.fullUrl)}" alt="${esc(label(image))}"></div><p>${esc(label(image))}</p><p class="image-source">${esc(sources(image))}${image.needsReview?' · 来自原表，待核对':''}</p><footer><button type="button" class="btn" data-image-prev ${index===0?'disabled':''}>上一张</button><button type="button" class="btn" data-image-next ${index===ready.length-1?'disabled':''}>下一张</button></footer>`;};
  lightbox.addEventListener('click',event=>{if(event.target.closest('[data-image-close]'))closeLightbox();else if(event.target.closest('[data-image-prev]')&&index>0){index--;paint();}else if(event.target.closest('[data-image-next]')&&index<ready.length-1){index++;paint();}});
  lightbox.addEventListener('cancel',event=>{event.preventDefault();closeLightbox();});
  lightbox.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'&&index>0){event.preventDefault();index--;paint();}if(event.key==='ArrowRight'&&index<ready.length-1){event.preventDefault();index++;paint();}event.stopPropagation();});
  document.body.append(lightbox);paint();lightbox.showModal();
 }
 function paint(session){
  if(current!==session||!session.root.isConnected)return;
  const ready=session.images.filter(i=>i.status==='ready').length;
  session.root.innerHTML=`<div class="form-section"><h3>订单图片${session.images.length?' · '+session.images.length+' 张':''}</h3><span class="small muted" role="status">${session.images.length?`已加载 ${ready} 张`:''}</span></div>${session.warnings.length?`<div class="alert">${session.warnings.map(esc).join('<br>')}</div>`:''}${session.images.length?`<p class="privacy-note">点击图片放大查看。网络图片首次查看时保存到本机；相同内容合并显示。</p><div class="order-image-grid">${session.images.map(image=>`<article class="order-image-card">${image.status==='ready'?`<button type="button" class="image-thumb" data-open-image="${image.id}" aria-label="放大图片：${esc(label(image))}"><img src="${esc(image.thumbUrl)}" alt="${esc(label(image))}" loading="lazy"></button>`:`<div class="image-placeholder"><span>${image.status==='failed'?'图片加载失败':'正在加载图片…'}</span>${image.status==='failed'?`<small>${esc(image.error)}</small><button type="button" class="btn" data-retry-image="${image.id}">重试图片</button>`:''}</div>`}<div class="image-caption"><b>${esc(label(image))}</b>${image.needsReview?'<span class="image-review">来自原表，待核对</span>':''}<small>${esc(sources(image))}</small>${image.status==='ready'?'<small>已保存在本机</small>':''}</div></article>`).join('')}</div>`:`<p class="privacy-note">${session.warnings.length?'图片来源暂时无法完整读取。':'原件未提供图片。'}</p>`}`;
 }
 async function cache(session,image){
  try{
   const result=await api(`/api/orders/${session.orderId}/images/${image.id}/cache`,{});
   if(current===session){session.images=result.images;paint(session);}
  }catch(e){if(current===session){const item=session.images.find(i=>i.id===image.id);if(item){item.status='failed';item.error=e.message;}paint(session);}}
 }
 async function mount(orderId){
  dispose();const root=document.querySelector('#order-images');if(!root)return;
  const session={orderId,root,images:[],warnings:[]};current=session;
  root.innerHTML='<div class="form-section"><h3>订单图片</h3></div><p class="privacy-note" role="status">正在读取原件中的图片…</p>';
  root.addEventListener('click',event=>{const openButton=event.target.closest('[data-open-image]'),retry=event.target.closest('[data-retry-image]');if(openButton)open(openButton.dataset.openImage);if(retry){const image=session.images.find(i=>i.id===retry.dataset.retryImage);if(image){image.status='pending';paint(session);void cache(session,image);}}});
  try{
   const result=await api(`/api/orders/${orderId}/images/prepare`,{});if(current!==session||!root.isConnected)return;
   session.images=result.images;session.warnings=result.warnings;paint(session);
   const pending=session.images.filter(i=>i.status!=='ready'),hasPending=pending.length>0;
   const worker=async()=>{while(pending.length&&current===session&&root.isConnected){const image=pending.shift();await cache(session,image);}};
   await Promise.all(Array.from({length:Math.min(3,pending.length)},worker));
   if(hasPending&&current===session&&root.isConnected){const latest=await api(`/api/orders/${orderId}/images/prepare`,{});if(current===session){session.images=latest.images;session.warnings=latest.warnings;paint(session);}}
  }catch(e){if(current===session){root.innerHTML=`<div class="form-section"><h3>订单图片</h3></div><div class="alert">${esc(e.message)}</div><button type="button" class="btn" data-reload-images>重新读取图片</button>`;root.querySelector('[data-reload-images]').onclick=()=>mount(orderId);}}
 }
 return {mount,dispose,lightboxOpen:()=>!!lightbox};
}
