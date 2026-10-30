import {requireDelivery} from './delivery-required.mjs';
import {newOrderNumber} from './order-number.mjs';
import {mountMobileQuery} from './mobile-query.js?v=20261018-query2';
import {MAX_FILES,MAX_FILE_BYTES,MAX_TOTAL_BYTES} from './upload-limits.mjs';
import {supplierPicker,wireSupplierPicker} from './supplier-picker.js';
import {wireOrderFormView} from './order-form-view.js';
import {itemShipments,shipmentText} from './shipments.mjs';
import {parseAddress,carrierOptions,detectCarrier,normalizeCarrier} from './address-parse.mjs';
let scannedPair=new URLSearchParams(location.hash.slice(1)).get('pair');
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
const $=s=>document.querySelector(s),form=$('#order-form');
form.addEventListener('invalid',e=>{const section=e.target.closest('details');if(section)section.open=true;},true);
let currentUsername='';
let csrf='',files=[],jobId='',busy=false,lastPayload='',requestId='',page=1,query='';
let supplierControl,formDraft={},attachments=[],editing=null,generatedNumber='';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('#supplier-slot').outerHTML=supplierPicker({},esc);
$('#carrier-options').innerHTML=carrierOptions.map(c=>`<option value="${esc(c)}">`).join('');
wireOrderFormView(form,esc,{key:'purchase-mobile-form-fields-v2',hiddenDefaults:['shippingCents'],requiredFields:['contacts'],label:'编辑字段'});
form.querySelector('[data-form-toggle=contacts]').parentElement.lastChild.textContent='收货与物流（必填）';
$('#mobile-field-slot').append(form.querySelector('.form-view-toolbar'));
$('#mobile-field-slot summary').textContent='字段';
$('#mobile-field-slot summary').setAttribute('aria-label','编辑字段');
$('#recognition-toggle').onclick=()=>{showEntry();$('#recognition-panel').open=!$('#recognition-panel').open;};
$('#recognition-panel').ontoggle=()=>$('#recognition-toggle').setAttribute('aria-expanded',String($('#recognition-panel').open));
async function loadOptions(){const data=await api('/form-options');mobileQuery.options(data);const select=form.elements.platform,current=select.value;select.replaceChildren(new Option('请选择采购平台',''),...data.platforms.map(p=>new Option(p,p)));select.value=current;if(supplierControl)supplierControl.update(data.orders,data.addresses,data.supplierProfiles);else supplierControl=await wireSupplierPicker(form,{orders:data.orders,api:async route=>route==='/api/addresses'?data.addresses:data.supplierProfiles,esc});}
let messageTimer;
const mobileQuery=mountMobileQuery({api,run,esc,onEdit:beginEdit});
const message=(text,error=false)=>{clearTimeout(messageTimer);$('#message').textContent=text;$('#message').classList.toggle('error',error);if(!error&&text.includes('配对成功'))messageTimer=setTimeout(()=>$('#message').textContent='',3000);};
async function api(route,options={}){
 let r;try{r=await fetch('/api/mobile'+route,{...options,cache:'no-store',headers:{'Idempotency-Key':options.headers?.['x-request-id']||crypto.randomUUID(),'x-mobile-csrf':csrf,...(window.workbenchTransport?{'x-review-token':csrf}:{}),...(window.workbenchTransport&&options.headers?.['x-request-id']?{'Idempotency-Key':options.headers['x-request-id']}:{}),...options.headers}});}catch{throw Error('无法连接电脑。请检查 Tailscale、电脑和采购软件是否在线；当前内容尚未确认保存。');}
 const data=await r.json();if(!r.ok){if(r.status===401){$('#pair').hidden=false;$('#workspace').hidden=true;}throw Object.assign(Error(data.error||'操作失败'),{status:r.status,canEstablishSession:data.canEstablishSession===true});}return data;
}
const post=(route,body,headers={})=>api(route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const usernameButton=document.createElement('button');usernameButton.type='button';usernameButton.id='username-settings';usernameButton.textContent='录入人';usernameButton.setAttribute('aria-label','设置录入人');document.querySelector('.mobile-topbar').insertBefore(usernameButton,$('#logout'));
function chooseUsername(){ $('#workspace').hidden=true;$('#username-panel').hidden=false;$('#custom-username-fields').hidden=true; }
usernameButton.onclick=chooseUsername;
async function selectUsername(username){const result=await post('/username',{username});currentUsername=result.username;usernameButton.textContent=currentUsername;$('#username-panel').hidden=true;$('#workspace').hidden=false;}
for(const b of document.querySelectorAll('[data-username]'))b.onclick=()=>run(()=>selectUsername(b.dataset.username));
$('#custom-username').onclick=()=>{$('#custom-username-fields').hidden=false;$('#username-input').focus();};
$('#confirm-username').onclick=()=>run(()=>selectUsername($('#username-input').value));
const deliveryStatus=text=>$('#delivery-status').textContent=text;
$('#edit-delivery').onclick=()=>{$('#delivery-tools').hidden=!$('#delivery-tools').hidden;$('#edit-delivery').textContent=$('#delivery-tools').hidden?'编辑地址':'收起';};
const applyDelivery=a=>{for(const [key,value] of Object.entries({recipient:a.name||a.recipient||'',phone:a.phone||'',address:a.address||''}))form.elements[key].value=value;};
const parseDelivery=()=>{try{const text=$('#delivery-text').value.trim();if(!text)return;const parsed=parseAddress(text);applyDelivery({recipient:parsed.recipient||form.elements.recipient.value,phone:parsed.phone||form.elements.phone.value,address:parsed.address});deliveryStatus('已识别并填入，请核对姓名、电话和地址；仅需复用时再保存到地址库。');}catch(e){deliveryStatus(e.message);}};
const addressField=form.elements.address;
addressField.placeholder='可粘贴包含姓名、电话、地址的整段文字，点击下方识别';
const parseInline=document.createElement('button');parseInline.type='button';parseInline.className='secondary inline-address-parse';parseInline.textContent='识别并填入';
const inlineStatus=document.createElement('small');inlineStatus.className='inline-address-status';inlineStatus.setAttribute('role','status');
addressField.after(parseInline,inlineStatus);
parseInline.onclick=()=>{try{const text=addressField.value.trim();if(!text){inlineStatus.textContent='请先粘贴收货信息。';return;}const parsed=parseAddress(text);applyDelivery({recipient:parsed.recipient||form.elements.recipient.value,phone:parsed.phone||form.elements.phone.value,address:parsed.address});inlineStatus.textContent='已填入，请核对姓名、电话和地址；未添加到地址库。';}catch(e){inlineStatus.textContent=e.message;}};
$('#parse-delivery').onclick=parseDelivery;
$('#delivery-text').addEventListener('paste',()=>setTimeout(parseDelivery,0));
$('#delivery-text').addEventListener('change',parseDelivery);
$('#save-delivery').onclick=async e=>{const b=e.currentTarget;b.disabled=true;try{await post('/addresses',{name:form.elements.recipient.value,phone:form.elements.phone.value,address:form.elements.address.value});deliveryStatus('已保存到电脑地址库');$('#delivery-addresses').hidden=true;}catch(e){deliveryStatus(e.message);}finally{b.disabled=false;}};
$('#pick-delivery').onclick=async()=>{const box=$('#delivery-addresses');box.hidden=false;box.textContent='正在读取地址库…';try{const rows=await api('/addresses');box.replaceChildren();if(!rows.length)box.textContent='暂无收货地址，可填写后保存。';for(const a of rows){const b=document.createElement('button');b.type='button';b.className='delivery-address-choice';b.textContent=[a.name,a.phone,a.address].filter(Boolean).join(' · ');b.onclick=()=>{applyDelivery(a);box.hidden=true;deliveryStatus('已填入所选地址，请核对。');};box.append(b);}}catch(e){box.textContent=e.message;}};

async function run(fn){if(busy)return;busy=true;const controls=[...document.querySelectorAll('button,input,select,textarea')].map(e=>[e,e.disabled]);controls.forEach(([e])=>e.disabled=true);try{await fn();}catch(e){message(e.message,true);}finally{busy=false;controls.forEach(([e,disabled])=>{if(e.isConnected)e.disabled=disabled;});if(!form.elements.platform.value)$('#order-supplier-choice').disabled=true;$('#recognition-toggle').disabled=!!editing;}}
function shipment(data={}){const row=document.createElement('div');row.className='shipment-row';for(const [name,label] of [['trackingNo','商品运单号'],['logisticsCompany','商品物流公司']]){const input=document.createElement(name==='logisticsCompany'?'select':'input');if(name==='logisticsCompany')input.innerHTML='<option value="">请选择物流公司</option>'+carrierOptions.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');input.dataset.shipmentKey=name;input.setAttribute('aria-label',label);input.placeholder=label.replace('商品','')+' *';input.required=true;input.value=name==='logisticsCompany'?normalizeCarrier(data[name]):data[name]||'';row.append(input);}const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='×';remove.setAttribute('aria-label','移除运单');remove.onclick=()=>row.remove();row.append(remove);row.querySelector('[data-shipment-key=trackingNo]').oninput=e=>{const carrier=row.querySelector('[data-shipment-key=logisticsCompany]');if(!carrier.value||carrier.dataset.auto==='true'){carrier.value=detectCarrier(e.target.value)||'';carrier.dataset.auto='true';}};row.querySelector('[data-shipment-key=logisticsCompany]').onchange=e=>delete e.target.dataset.auto;return row;}
function item(data={}){
 const box=document.createElement('div');box.className='item item-columns';box.dataset.sku=data.sku||'';
 const defs=[['title','商品名称','text'],['spec','规格','text'],['qty','数量','number'],['unit','单位','text'],['unitPriceCents','单价（元，可留空）','number']];
 for(const [name,label,type] of defs){const input=document.createElement('input');input.dataset.field=name;input.type=type;input.setAttribute('aria-label',label);input.placeholder=label;if(type==='number'){input.min='0';input.step=name==='qty'?'any':'0.01';input.inputMode='decimal';}if(['title','qty'].includes(name))input.required=true;input.value=name==='unitPriceCents'?(data[name]==null?'':(data[name]/100).toFixed(2)):(data[name]??(name==='qty'?1:name==='unit'?'个':''));box.append(input);}
 const logistics=document.createElement('div');logistics.className='item-shipments';const rows=document.createElement('div');rows.className='shipment-rows';for(const s of itemShipments(data).length?itemShipments(data):[{}])rows.append(shipment(s));const add=document.createElement('button');add.type='button';add.className='secondary';add.textContent='＋ 运单';add.onclick=()=>rows.append(shipment());logistics.append(rows,add);box.append(logistics);
 const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='移除商品';remove.onclick=()=>{if($('#items').children.length>1)box.remove();};box.append(remove);$('#items').append(box);
}
function reset(){editing=null;$('#edit-banner').hidden=true;$('#save').textContent='确认保存到电脑';$('#existing-attachments').replaceChildren();$('#recognition-toggle').disabled=false;formDraft={};const toggles=[...form.querySelectorAll('[data-form-toggle]')].map(e=>[e,e.checked]);form.reset();toggles.forEach(([e,checked])=>e.checked=checked);$('#items').replaceChildren();item();const d=new Date();form.elements.date.value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;generatedNumber=newOrderNumber(form.elements.platform.value,form.elements.date.value);form.elements.orderNo.value=generatedNumber;supplierControl?.refresh();attachments=[];renderAttachments();files=[];jobId='';$('#file-list').replaceChildren();$('#source-status').textContent='也可以直接填写下方采购单。';$('#source-text').value='';lastPayload='';requestId='';}
for(const name of ['platform','date'])form.elements[name].addEventListener('change',()=>{if(!editing&&form.elements.orderNo.value===generatedNumber){generatedNumber=newOrderNumber(form.elements.platform.value,form.elements.date.value);form.elements.orderNo.value=generatedNumber;}});
function fill(o){formDraft=structuredClone(o);for(const e of form.elements){if(!e.name||!Object.hasOwn(o,e.name))continue;e.value=e.name.endsWith('Cents')?(o[e.name]==null?'':(o[e.name]/100).toFixed(2)):(o[e.name]??'');}for(const key of ['name','phone','address'])form.elements['supplierContact-'+key].value=o.supplierContact?.[key]||'';supplierControl?.refresh();$('#items').replaceChildren();for(const i of o.items||[])item(i);if(!$('#items').children.length)item();$('#confirmed').checked=false;}
function beginEdit(order,existing=[]){
 reset();editing=order.id;fill(order);$('#recognition-panel').open=false;$('#recognition-toggle').disabled=true;
 $('#edit-banner').hidden=false;$('#edit-order-number').textContent=' · '+order.orderNo;$('#save').textContent='确认保存修改';
 for(const a of existing){const link=document.createElement('a');link.className='upload-history-link';link.href=a.downloadUrl;link.textContent=a.filename;$('#existing-attachments').append(link,document.createElement('br'));}
 showEntry();$('#edit-banner').scrollIntoView({behavior:'smooth'});
}
$('#cancel-edit').onclick=()=>{const id=editing;reset();if(id){showQuery();run(()=>mobileQuery.showOrder(id));}};
function renderFiles(){const list=$('#file-list');list.replaceChildren();files.forEach((f,index)=>{const row=document.createElement('li');row.textContent=f.name+' ';const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent='移除';b.onclick=()=>{files.splice(index,1);jobId='';renderFiles();};row.append(b);list.append(row);});$('#source-status').textContent=files.length?'已选 '+files.length+' 个原单，请识别后核对保存。':'直接填写采购信息即可保存。';}
for(const id of ['camera','files'])$('#'+id).onchange=e=>{files.push(...e.target.files);jobId='';e.target.value='';renderFiles();};
function renderAttachments(){
 const list=$('#attachment-list');list.replaceChildren();
 for(const attachment of attachments){const row=document.createElement('li');row.textContent=attachment.file.name+' ';const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='移除';remove.onclick=()=>{attachments=attachments.filter(a=>a!==attachment);renderAttachments();};row.append(remove);list.append(row);}
}
$('#attachment-files').onchange=e=>{
 const selected=[...attachments,...[...e.target.files].map(file=>({file}))];e.target.value='';
 if(selected.length>MAX_FILES||selected.some(a=>a.file.size>MAX_FILE_BYTES)||selected.reduce((n,a)=>n+a.file.size,0)>MAX_TOTAL_BYTES){message('附件最多20个，单个50MB，总计200MB',true);return;}
 attachments=selected;renderAttachments();
};
async function uploadAttachments(){
 for(const attachment of attachments){
  if(attachment.id)continue;message('正在上传附件：'+attachment.file.name+'，请保持页面打开…');
  const data=new FormData();data.append('files',attachment.file);
  const saved=await api('/attachments',{method:'POST',body:data});attachment.id=saved[0].id;
 }
 return attachments.map(a=>a.id);
}
$('#recognize').onclick=()=>run(async()=>{
 if(!files.length)throw Error('请先拍照或选择原单');if(files.length>MAX_FILES||files.some(f=>f.size>MAX_FILE_BYTES)||files.reduce((n,f)=>n+f.size,0)>MAX_TOTAL_BYTES)throw Error('最多20个文件，单个50MB，总计200MB');
 message('正在上传原单到电脑，请保持页面打开…');
 const data=new FormData();files.forEach(f=>data.append('file',f));const task=await api('/ocr',{method:'POST',body:data});jobId='';
 const start=Date.now();while(Date.now()-start<310000){const job=await api('/ocr/'+task.id);message('本机正在识别原单… '+Math.round(job.progress||0)+'%');if(job.status==='done'){fill(job.result.order);jobId=task.id;$('#source-status').textContent='识别完成。请核对所有字段，保存时将保留原单。';message('识别完成，请核对后保存');return;}if(job.status==='failed')throw Error(job.error||'识别失败');await new Promise(r=>setTimeout(r,1200));}throw Error('识别等待超时，请重新识别');
});
$('#text-recognize').onclick=()=>run(async()=>{if(files.length)throw Error('已选择原单，请使用「识别所选原单」，或先移除文件');if(!$('#source-text').value.trim())throw Error('请先粘贴文字');const r=await post('/text',{text:$('#source-text').value,platform:form.elements.platform.value});fill(r.order);jobId='';message('文字已识别，请核对后保存');});
$('#add-item').onclick=()=>item();
const cents=v=>{if(!/^\d+(?:\.\d{1,2})?$/.test(v))throw Error('金额请填写非负数，最多两位小数');const [a,b='']=v.split('.');return Number(a)*100+Number(b.padEnd(2,'0'));};
form.onsubmit=e=>{e.preventDefault();run(async()=>{
 if(files.length&&!jobId)throw Error('原单尚未识别，请先识别或移除所选文件');
 const body={...formDraft};
 for(const e of form.elements)if(e.name)body[e.name]=e.value;
 if(!body.platform)throw Error('请先选择采购平台');if(!body.supplier?.trim())throw Error('请选择供应商或填写新供应商');
 for(const k of ['amountCents','refundCents','shippingCents'])body[k]=cents(body[k]||(k==='amountCents'?'':'0'));
 body.supplierContact=Object.fromEntries(['name','phone','address'].map(k=>[k,form.elements['supplierContact-'+k].value]));for(const k of ['name','phone','address'])delete body['supplierContact-'+k];
 body.items=[...$('#items').children].map(row=>{const i=Object.fromEntries([...row.querySelectorAll('[data-field]')].map(e=>[e.dataset.field,e.value]));i.sku=row.dataset.sku;i.shipments=[...row.querySelectorAll('.shipment-row')].map(s=>Object.fromEntries([...s.querySelectorAll('[data-shipment-key]')].map(e=>[e.dataset.shipmentKey,e.value]))).filter(s=>s.trackingNo.trim()||s.logisticsCompany.trim());i.qty=Number(i.qty);i.unitPriceCents=i.unitPriceCents===''?null:cents(i.unitPriceCents);return i;});
 requireDelivery(body);
 if(jobId)body.ocrJobId=jobId;
 if(!jobId&&$('#source-text').value.trim())body.recognizedText=$('#source-text').value;
 if(attachments.length)body.attachmentIds=[...new Set([...(formDraft.attachmentIds||[]),...await uploadAttachments()])];
 const payload=JSON.stringify(body);if(payload!==lastPayload){lastPayload=payload;requestId=crypto.randomUUID();}
 const wasEditing=!!editing;const saved=editing?await api('/orders/'+editing,{method:'PUT',headers:{'content-type':'application/json','x-request-id':requestId},body:payload}):await post('/orders',body,{'x-request-id':requestId});reset();message((wasEditing?'修改已保存到电脑：':'已保存到电脑：')+saved.order.orderNo);try{await loadOptions();}catch{message('已保存到电脑：'+saved.order.orderNo+'；供应商列表暂未刷新，请刷新页面');}if(wasEditing){showQuery();await mobileQuery.showOrder(saved.order.id);}
 });};
$('#pair-form').onsubmit=e=>{e.preventDefault();run(async()=>{const r=await post('/pair',{code:$('#pair-form').elements.code.value});csrf=r.csrf;$('#pair-form').reset();$('#pair').hidden=true;$('#workspace').hidden=false;await loadOptions();chooseUsername();message('配对成功，请选择录入人');});};
$('#logout').onclick=()=>run(async()=>{await post('/logout',{});if(window.workbenchTransport)location.assign('/');else location.reload();});
function showEntry(){$('#entry').hidden=false;$('#query').hidden=true;$('#entry-tab').setAttribute('aria-pressed','true');$('#query-tab').setAttribute('aria-pressed','false');}
$('#entry-tab').onclick=showEntry;
function showQuery(){$('#entry').hidden=true;$('#query').hidden=false;$('#entry-tab').setAttribute('aria-pressed','false');$('#query-tab').setAttribute('aria-pressed','true');window.scrollTo(0,0);}
$('#query-tab').onclick=()=>{showQuery();run(()=>mobileQuery.open());};
reset();run(async()=>{try{const code=scannedPair;scannedPair=null;const s=code?await post('/pair',{code}):await api('/session').catch(e=>(window.workbenchTransport||e.canEstablishSession)&&[401,403].includes(e.status)?post('/pair',{}):Promise.reject(e));csrf=s.csrf;$('#pair').hidden=true;$('#workspace').hidden=false;await loadOptions();currentUsername=s.username||'';usernameButton.textContent=currentUsername||'录入人';chooseUsername();if(code)message('扫码配对成功，请选择录入人');}catch(e){$('#pair').hidden=false;message(e.message,true);}});
