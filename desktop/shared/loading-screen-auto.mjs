import {loadingMarkup} from './loading-screen.mjs';

// Adapt legacy text placeholders only. Errors, forms, platform job messages and
// real progress values remain owned by their existing business components.
const waiting=/^正在(?:打开|读取|加载|连接|确认工作身份)/;
const busyText=/正在|处理中|读取中|加载中/;
function upgrade(root){
  const candidates=[];
  if(root instanceof Element&&root.matches('.loading,.empty,#delivery-addresses'))candidates.push(root);
  if(root.querySelectorAll)candidates.push(...root.querySelectorAll('.loading,.empty,#delivery-addresses'));
  for(const element of candidates){
    if(element.childElementCount||!waiting.test(element.textContent.trim()))continue;
    const status=element.textContent.trim();
    const variant=element.id==='delivery-addresses'?'inline':element.parentElement?.id==='app'?'full':'content';
    element.innerHTML=loadingMarkup({variant,brand:'五成电子商务工作台',subtitle:document.title.split('·')[0].trim(),status,logo:document.body.dataset.loadingLogo||'./loading-logo.png',note:'正在为您准备所需的业务数据'});
  }
  for(const progress of document.querySelectorAll('progress:not(.lt-loading__progress)'))progress.classList.add('lt-progress');
  for(const button of document.querySelectorAll('button'))button.classList.toggle('lt-loading-button',button.disabled&&busyText.test(button.textContent));
}
let scheduled=false;
const observer=new MutationObserver(records=>{
  if(scheduled)return;
  // Ignore mutations made solely inside our own visual markup.
  if(records.every(r=>r.target instanceof Element&&r.target.closest('.lt-loading')||r.target.parentElement?.closest('.lt-loading')))return;
  scheduled=true;queueMicrotask(()=>{scheduled=false;upgrade(document);});
});
upgrade(document);
observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled']});
window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
