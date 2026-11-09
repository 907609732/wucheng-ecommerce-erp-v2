const publicPrefix=(document.currentScript?.src||'').match(/^(?:https?:\/\/[^/]+)?(\/app\/wuchengerp)\/web\//)?.[1]||'';
const selected=new URLSearchParams(location.search).get('module')||'sales';
const message=document.querySelector('#browser-message'),view=document.querySelector('#browser-view');
async function openBrowser(){
 try{
  if(!['sales','overview'].includes(selected))throw Error('请选择销售或经营总览浏览器');
  const response=await fetch(publicPrefix+'/api/workbench/v1/session',{cache:'no-store'});const session=await response.json();if(!response.ok)throw Error(session.error||'工作台会话不可用');
  for(const link of document.querySelectorAll('[data-module]'))link.setAttribute('aria-current',link.dataset.module===selected?'page':'false');
  const target=new URL(publicPrefix+'/web/novnc/vnc.html',location.origin);
  target.search=new URLSearchParams({autoconnect:'true',resize:'scale',host:location.hostname,port:location.port||(location.protocol==='https:'?'443':'80'),encrypt:location.protocol==='https:'?'true':'false',path:(publicPrefix+'/api/workbench/v1/native-browser/'+selected+'/websockify').replace(/^\//,''),show_dot:'true'});
  view.src=target.href;view.hidden=false;message.textContent='登录状态由平台确认；关闭此页面后浏览器与登录资料仍会保留。';
 }catch(error){message.textContent=error.message;}
}
void openBrowser();
