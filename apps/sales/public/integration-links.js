document.getElementById('open-business-overview')?.addEventListener('click',async e=>{
  const button=e.currentTarget;button.disabled=true;
  try{
    if(window.lingtuShell){await window.lingtuShell.open('overview');return;}
    if(window.workbenchTransport){location.assign('/apps/overview/');return;}
    const session=await(await fetch('/api/integration/v1/review-session')).json();
    const response=await fetch('/api/integration/v1/overview/open',{method:'POST',headers:{'Content-Type':'application/json','x-review-token':session.nonce},body:'{}'});
    const data=await response.json();if(!response.ok)throw Error(data.error);
    const target=new URL(data.url);if(target.hostname!=='127.0.0.1'||target.protocol!=='http:')throw Error('总览地址无效');
    location.assign(target.href);
  }catch(error){alert(error.message);}finally{button.disabled=false;}
});
