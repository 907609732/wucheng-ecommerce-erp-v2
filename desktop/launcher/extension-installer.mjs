import {loadingMarkup} from '../shared/loading-screen.mjs';

const message=error=>String(error?.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
export function createExtensionInstaller({launcher,beforeShow,afterClose}){
  const button=document.getElementById('nav-warehouse'),badge=document.createElement('small');
  badge.textContent='正在检查';button?.append(' ',badge);
  const dialog=document.createElement('dialog');dialog.className='review-dialog';dialog.setAttribute('aria-labelledby','warehouse-extension-title');
  dialog.innerHTML='<h2 id="warehouse-extension-title">安装菜鸟云仓扩展</h2><p>安装后可从左侧打开云仓，使用库存、月度销量和提醒功能。</p><p data-details></p><p data-status role="status"></p><div data-loading></div><div class="actions"><button class="btn primary" type="button" data-install>下载并安装</button><button class="btn" type="button" data-close>关闭</button></div>';
  document.body.append(dialog);
  const details=dialog.querySelector('[data-details]'),status=dialog.querySelector('[data-status]'),loading=dialog.querySelector('[data-loading]'),install=dialog.querySelector('[data-install]'),close=dialog.querySelector('[data-close]');
  let busy=false,resolveRequest,pendingRequest,disposed=false;
  async function refresh(){
    const value=await launcher.extensionStatus('warehouse');
    if(!disposed){badge.textContent=value.installed?'已安装':value.state==='installing'?'安装中':value.needsUpdate?'需更新':'待安装';button?.setAttribute('aria-label','云仓同步 · '+badge.textContent);}
    return value;
  }
  async function loadPlan(){
    install.disabled=true;details.textContent='正在读取扩展信息';
    try{const plan=await launcher.extensionPlan('warehouse');details.textContent='版本 '+plan.version+' · 下载大小 '+(plan.bytes/1024/1024).toFixed(1)+' MB';install.disabled=false;}
    catch(error){details.textContent='';status.textContent=message(error);}
  }
  const unsubscribe=launcher.onProgress?.(value=>{
    if(!busy||value.id!=='warehouse')return;
    const phases={downloading:'正在下载',verify:'正在校验',dependencies:'正在解压',copy:'正在安装',runtime:'正在准备运行环境',initialize:'正在检查账本',ready:'安装完成',error:'安装失败',cancelled:'已取消'};
    const current=value.received??value.processed,total=value.total;
    const measured=Number.isFinite(current)&&Number.isFinite(total)&&total>0&&current>=0&&current<=total;
    loading.innerHTML=loadingMarkup({variant:'inline',module:'warehouse',state:value.phase,status:phases[value.phase]||'正在安装',note:value.error||'',progress:measured?{value:current,total}:undefined,logo:'../assets/lingtu-icon.png'});
  });
  install.addEventListener('click',async()=>{
    if(busy)return;busy=true;install.disabled=true;close.textContent='取消安装';status.textContent='';badge.textContent='安装中';
    try{
      await launcher.extensionInstall('warehouse');
      if(!(await refresh()).installed)throw Error('安装文件尚未通过校验，请重试');
      dialog.close('installed');
    }catch(error){status.textContent=message(error);install.textContent='重试安装';}
    finally{busy=false;install.disabled=false;close.disabled=false;close.textContent='关闭';loading.replaceChildren();await refresh().catch(()=>{});}
  });
  async function cancel(){if(busy){close.disabled=true;try{await launcher.extensionCancel('warehouse');}catch(error){status.textContent=message(error);close.disabled=false;}}else dialog.close();}
  close.addEventListener('click',()=>void cancel());
  dialog.addEventListener('cancel',event=>{event.preventDefault();void cancel();});
  dialog.addEventListener('close',()=>{const resolve=resolveRequest;resolveRequest=null;void Promise.resolve(afterClose()).finally(()=>resolve?.(dialog.returnValue==='installed'));});
  function request(){
    if(pendingRequest)return pendingRequest;
    pendingRequest=(async()=>{
      const value=await refresh();if(value.installed)return true;
      await beforeShow();dialog.returnValue='';status.textContent=value.needsUpdate?'已有扩展需要更新或修复，原有账本将保留。':'';install.textContent='下载并安装';
      const result=new Promise(resolve=>{resolveRequest=resolve;});dialog.showModal();void loadPlan();return result;
    })().finally(()=>{pendingRequest=null;});
    return pendingRequest;
  }
  void refresh().catch(()=>{badge.textContent='待检查';});
  return {request,dispose(){disposed=true;unsubscribe?.();resolveRequest?.(false);dialog.remove();}};
}
