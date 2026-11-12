const publicPrefix=(document.currentScript?.src||'').match(/^(?:https?:\/\/[^/]+)?(\/app\/wuchengerp(?:trial)?)\/web\//)?.[1]||'';
const selected=new URLSearchParams(location.search).get('module')||'sales';
const message=document.querySelector('#browser-message'),view=document.querySelector('#browser-view');
async function openBrowser(){
 try{
  if(!['sales','overview'].includes(selected))throw Error('请选择销售或经营总览浏览器');
  const response=await fetch(publicPrefix+'/api/workbench/v1/session',{cache:'no-store'});const session=await response.json();if(!response.ok)throw Error(session.error||'工作台会话不可用');
  const shared=session.nativeBrowser?.shared===true;
  const chooser=document.querySelector('#browser-modules'),description=document.querySelector('#browser-description');
  if(chooser)chooser.hidden=shared;
  if(description)description.textContent=shared?'销售与经营总览共用一个菜鸟账号和登录状态，各自在独立标签页采集，任务会自动排队。切换账号会同时影响两个模块。':'销售与经营总览各自保留登录状态。请在对应浏览器中完成登录，再回到业务台连接采集。';
  for(const link of document.querySelectorAll('[data-module]'))link.setAttribute('aria-current',link.dataset.module===selected?'page':'false');
  const target=new URL(publicPrefix+'/web/novnc/vnc.html',location.origin);
  target.search=new URLSearchParams({autoconnect:'true',resize:'scale',host:location.hostname,port:location.port||(location.protocol==='https:'?'443':'80'),encrypt:location.protocol==='https:'?'true':'false',path:(publicPrefix+'/api/workbench/v1/native-browser/'+selected+'/websockify').replace(/^\//,''),show_dot:'true'});
  view.src=target.href;view.hidden=false;message.textContent=shared?'登录或验证完成后，回到业务台连接采集。关闭此页面不会退出菜鸟或停止后台采集。':'登录状态由平台确认；关闭此页面后浏览器与登录资料仍会保留。';
 }catch(error){message.textContent=error.message;}
}
void openBrowser();
