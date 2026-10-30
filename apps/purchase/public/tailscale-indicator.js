let cached=null,pending=null,managedSession=false;
export async function refreshTailscaleIndicator({managed}={}){
 if(typeof managed==='boolean')managedSession=managed;
 if(!document.querySelector('#tailscale-indicator'))return;
 if(window.workbenchTransport||managedSession){const el=document.querySelector('#tailscale-indicator');if(el){el.textContent=managedSession?'工作台已登录 · 手机录入':'工作台安全连接';if(managedSession)el.setAttribute('href','/mobile.html');else el.removeAttribute('href');el.classList.remove('connection-warning');}const card=document.querySelector('.local-card');if(card){const text=card.querySelector('p'),small=card.querySelector('small');if(text)text.textContent='工作台已连接 · 数据已保存';if(small)small.textContent='采购数据由主机统一保存';}return;}
 const render=()=>{const el=document.querySelector('#tailscale-indicator');if(!el||!cached)return;el.textContent=cached.text;el.classList.toggle('connection-warning',cached.warning);};
 if(cached&&Date.now()-cached.at<15000){render();return;}
 if(pending){await pending;render();return;}
 pending=(async()=>{try{const r=await fetch('/api/mobile-admin/tailscale/status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();cached={at:Date.now(),text:!s.connected?'手机连接：'+s.message:!s.mobileEnabled?'手机入口未开启':!s.serveReady?'手机连接：请检查私有入口':'手机连接正常 · Tailscale',warning:!s.connected||!s.mobileEnabled||!s.serveReady};}catch{cached={at:Date.now(),text:'手机连接状态检测失败，点击检查',warning:true};}})().finally(()=>pending=null);
 await pending;render();
}
setInterval(()=>{if(!document.hidden)void refreshTailscaleIndicator();},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshTailscaleIndicator();});
