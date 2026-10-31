import {pathToFileURL} from 'node:url';

export function formatPreparationProgress(value={},names={}){
 const labels={verify:'正在校验程序文件',copy:'正在准备业务程序',runtime:'正在准备运行环境',initialize:'正在初始化预览账本',ready:'准备完成'};
 const phase=Object.hasOwn(labels,value.phase)?value.phase:'preparing',label=labels[phase]||'正在准备工作台';
 const component=names[value.component],version=typeof value.version==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)?value.version:null;
 const measured=Number.isSafeInteger(value.processed)&&Number.isSafeInteger(value.total)&&value.processed>=0&&value.total>0&&value.processed<=value.total;
 const detail=[component&&(component+(version?' · '+version:'')),measured?`已处理 ${value.processed.toLocaleString('zh-CN')} / ${value.total.toLocaleString('zh-CN')} 项`:phase==='ready'?'程序文件已准备完成。':'正在校验程序与本机数据，请稍候。'].filter(Boolean).join(' · ');
 return {phase,label,detail,...(measured?{processed:value.processed,total:value.total}:{})};
}

/** Activation may start only after load, Electron's first render and the visible page's paint acknowledgement. */
export function createPreparationWindow({BrowserWindow,ipcMain,html,preload,icon,signal,isQuitting=()=>false,onCancel=()=>{},onClosed=()=>{}}){
 const window=new BrowserWindow({show:false,width:960,height:600,minWidth:480,minHeight:300,resizable:true,maximizable:false,minimizable:true,title:'准备五成电子商务工作台',icon,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const contents=window.webContents,expectedUrl=pathToFileURL(html).href;
 let loaded=false,firstRender=false,paintRequested=false,settled=false,status,resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
 const abortError=()=>signal?.reason instanceof Error?signal.reason:Object.assign(Error('工作台准备已取消'),{name:'AbortError'});
 function removeReadiness(){ipcMain.removeListener('launcher:preparation-painted',painted);contents.removeListener('did-finish-load',loadedPage);contents.removeListener('did-fail-load',failed);contents.removeListener('render-process-gone',gone);}
 function fail(error){if(settled)return;settled=true;removeReadiness();rejectReady(error);}
 function requestPaint(){if(settled||!loaded||!firstRender||paintRequested)return;if(signal?.aborted)return fail(abortError());paintRequested=true;window.show();contents.send('launcher:preparation-paint-check');}
 function painted(event){if(!paintRequested||event.sender!==contents||event.senderFrame?.url&&event.senderFrame.url!==expectedUrl||settled)return;settled=true;removeReadiness();resolveReady(window);}
 function failed(_event,code,_description,_url,isMainFrame){if(isMainFrame!==false)fail(Error('准备窗口加载失败（'+code+'）'));}
 function gone(_event,details){fail(Error('准备窗口显示进程已退出（'+(details?.reason||'unknown')+'）'));}
 function loadedPage(){if(contents.getURL()!==expectedUrl)return;contents.removeListener('did-finish-load',loadedPage);loaded=true;if(status&&!window.isDestroyed())contents.send('launcher:preparation',status);requestPaint();}
 function aborted(){fail(abortError());if(!window.isDestroyed())window.destroy();}
 window.setMenu?.(null);contents.setWindowOpenHandler(()=>({action:'deny'}));contents.on('will-navigate',event=>event.preventDefault());
 contents.on('did-finish-load',loadedPage);
 window.once('ready-to-show',()=>{firstRender=true;requestPaint();});
 ipcMain.on('launcher:preparation-painted',painted);contents.on('did-fail-load',failed);contents.on('render-process-gone',gone);
 window.on('close',event=>{if(!isQuitting()){event.preventDefault();onCancel();}});
 window.once('closed',()=>{signal?.removeEventListener('abort',aborted);fail(abortError());onClosed();});
 signal?.addEventListener('abort',aborted,{once:true});
 if(signal?.aborted)aborted();else try{Promise.resolve(window.loadFile(html)).catch(fail);}catch(error){fail(error);}
 return {window,ready,update(value){status=value;if(loaded&&!window.isDestroyed())contents.send('launcher:preparation',status);},destroy(){signal?.removeEventListener('abort',aborted);removeReadiness();if(!window.isDestroyed())window.destroy();}};
}

export function createPreparationShutdown({controller,getActivation,getHost,getGateway,quit,onError=()=>{}}){
 let pending=false,finished=false;
 return event=>{
  const activation=getActivation();
  if(!finished&&(pending||activation||getHost()||getGateway())){
   event.preventDefault();if(pending)return;pending=true;
   controller.abort();
   void(async()=>{try{await activation?.catch(()=>{});await getGateway()?.stop();await getHost()?.close();}catch(error){try{onError(error);}catch{}}finally{finished=true;pending=false;quit();}})();
  }else controller.abort();
 };
}
