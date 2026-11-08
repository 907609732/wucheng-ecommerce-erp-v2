export function paymentEvidenceMarkup(payment,esc){
 if(!payment.evidence?.length)return '<span class="muted">—</span>';
 return '<div class="payment-evidence-thumbs">'+payment.evidence.map(e=>{const url='/api/payments/'+encodeURIComponent(payment.id)+'/evidence/'+encodeURIComponent(e.id);return `<a href="${url}" target="_blank" rel="noopener" title="查看${esc(e.filename)}"><img src="${url}" loading="lazy" alt="付款凭证：${esc(e.filename)}"></a>`;}).join('')+'</div>';
}
export function mountPaymentEvidence(form){
 const input=form.querySelector('[name=evidence]'),preview=form.querySelector('[data-payment-preview]'),error=form.querySelector('[data-payment-image-error]');
 let urls=[],dead=false,busy=false;
 const revoke=()=>{urls.forEach(url=>URL.revokeObjectURL(url));urls=[];};
 function draw(){
  revoke();preview.replaceChildren();const files=[...input.files];
  const problem=files.length>6?'每次最多上传6张图片':files.some(f=>!f.size||f.size>10*1024*1024)?'每张图片须在10MB以内':files.some(f=>f.type&&!['image/png','image/jpeg','image/webp'].includes(f.type))?'请选择PNG、JPEG或WebP图片':'';
  input.setCustomValidity(problem);error.textContent=problem;
  if(problem)return;
  files.forEach((file,index)=>{
   const card=document.createElement('div'),img=document.createElement('img'),caption=document.createElement('span'),button=document.createElement('button');card.className='payment-image-card';
   const url=URL.createObjectURL(file);urls.push(url);img.src=url;img.alt=file.name;caption.textContent=file.name;button.type='button';button.className='text-button';button.textContent='移除';button.disabled=busy;
   button.onclick=()=>{if(busy)return;const data=new DataTransfer();files.filter((_,i)=>i!==index).forEach(f=>data.items.add(f));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
   card.append(img,caption,button);preview.append(card);
  });
 }
 input.addEventListener('change',draw);
 return {setBusy(value){if(dead)return;busy=value;input.disabled=value;preview.querySelectorAll('button').forEach(b=>b.disabled=value);},destroy(){dead=true;revoke();input.removeEventListener('change',draw);}};
}
