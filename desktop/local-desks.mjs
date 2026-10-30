import {WebContentsView,ipcMain,shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ServiceManager} from './shared/service-manager.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export function installDeskViews(win,{manager=new ServiceManager(),notify=()=>{},includeWarehouse=false,isRemote=()=>false,partitionFor=id=>'persist:lingtu-'+id,beforeOpen=async()=>{},prepareView=async()=>{},authorizeOperation=()=>{},decorateURL=(_id,url)=>url}={}){
  const views=new Map(),readyViews=new Set();let active='',generation=0,bounds={x:0,y:0,width:0,height:0};
  const rootSender=e=>e.sender===win.webContents&&e.senderFrame===win.webContents.mainFrame;
  const childSender=e=>[...views.values()].some(v=>e.sender===v.webContents&&e.senderFrame===v.webContents.mainFrame);
  const handlers=[];
  function handle(name,fn){ipcMain.handle(name,(event,...args)=>{authorizeOperation(name,args,event);return fn(event,...args);});handlers.push(name);}
  const layout=()=>{
    const size=win.getContentBounds(),zoom=win.webContents.getZoomFactor?.()||1;
    const x=Math.max(0,Math.min(size.width,Math.round(bounds.x*zoom))),y=Math.max(0,Math.min(size.height,Math.round(bounds.y*zoom)));
    const right=Math.max(0,Math.min(size.width,Math.round((bounds.x+bounds.width)*zoom))),bottom=Math.max(0,Math.min(size.height,Math.round((bounds.y+bounds.height)*zoom)));
    const rect={x,y,width:right-x,height:bottom-y},visible=rect.width>0&&rect.height>0&&!win.isMinimized?.();
    for(const [id,v]of views){const show=visible&&active===id;if(show)v.setBounds(rect);v.setVisible(show);}
    return visible;
  };
  const hide=(cancel=true)=>{if(cancel)generation++;active='';for(const v of views.values())v.setVisible(false);};
  async function open(id,route){
    if(!['purchase','sales','overview',...(isRemote()?['warehouse','exporter']:[])].includes(id))throw Error('该扩展不支持内嵌打开');
    if(route!==undefined&&(typeof route!=='string'||route.length>2000||!/^\/(?:[a-zA-Z0-9/_-]+\.html)?(?:\?[a-zA-Z0-9%=&._-]+)?(?:#[a-zA-Z0-9/_-]+)?$/.test(route)||route.includes('..')))throw Error('扩展页面无效');
    const mine=++generation;hide(false);await beforeOpen(id);
    if(mine!==generation)return {cancelled:true};
    const cap=await manager.ensure(id);
    if(mine!==generation)return {cancelled:true};
    const targetURL=decorateURL(id,cap.url+(route||'/'));
    let view=views.get(id);
    if(!view){
      view=new WebContentsView({webPreferences:{preload:path.join(here,'extension-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:partitionFor(id)}});
      views.set(id,view);win.contentView.addChildView(view);view.setVisible(false);
      const external=url=>{let target;try{target=new URL(url);}catch{return;}if(['127.0.0.1','localhost','[::1]'].includes(target.hostname)){notify('此本机链接不属于当前测试工作台，已阻止跳转');return;}if(/^https?:$/.test(target.protocol))void shell.openExternal(url).catch(e=>notify(e.message));};
      const crossModule=url=>{
        let target;try{target=new URL(url);}catch{return false;}const base=new URL(cap.url),pointer=target.pathname.match(/^\/apps\/(warehouse|purchase|sales|overview|exporter)(\/.*)?$/);let destination,route;
        if(isRemote()){
          if(target.origin!==base.origin)return false;
          if(!pointer)return false;destination=pointer[1];route=(pointer[2]||'/')+target.search+target.hash;
        }else{
          if(target.protocol!=='http:'||!['127.0.0.1','localhost'].includes(target.hostname))return false;
          const originDesk=['purchase','sales','overview'].find(candidate=>{try{return Number(target.port)===manager.config(candidate).port;}catch{return false;}});
          if(target.origin!==base.origin&&!originDesk)return false;
          destination=pointer?pointer[1]:originDesk;route=(pointer?(pointer[2]||'/'):target.pathname)+target.search+target.hash;
        }
        if(!destination||destination===id&&!pointer)return false;
        win.webContents.send('desks:navigate',{id:destination,...(route!=='/'?{route}:{})});return true;
      };
      view.webContents.setWindowOpenHandler(({url})=>{if(crossModule(url))return {action:'deny'};if(url.startsWith(cap.url+'/'))void view.webContents.loadURL(url).catch(e=>notify(e.message));else external(url);return {action:'deny'};});
      const navigate=(event,url)=>{if(crossModule(url)){event.preventDefault();return;}if(!url.startsWith(cap.url+'/')){event.preventDefault();external(url);}};
      view.webContents.on('will-navigate',navigate);view.webContents.on('will-redirect',navigate);
      view.webContents.on('render-process-gone',()=>notify(`${id} 页面意外退出，请重新打开`));
      view.webContents.session.on('will-download',(_e,item)=>{item.setSaveDialogOptions({title:'保存扩展导出文件'});});
    }
    await prepareView({id,view,cap});
    const currentURL=view.webContents.getURL?.();
    if(!readyViews.has(view)||currentURL?.startsWith('chrome-error:')||route&&currentURL!==targetURL){readyViews.delete(view);await view.webContents.loadURL(targetURL);readyViews.add(view);}
    if(mine!==generation)return {cancelled:true};
    hide(false);active=id;if(layout())view.webContents.focus();
    return {id,url:cap.url};
  }
  handle('desks:status',e=>{if(!rootSender(e))throw Error('来源不符');return manager.status({includeWarehouse});});
  handle('desks:open',(e,{id,route}={})=>{if(!rootSender(e))throw Error('来源不符');return open(id,route);});
  handle('desks:hide',e=>{if(!rootSender(e))throw Error('来源不符');hide();});
  handle('desks:bounds',(e,b)=>{if(!rootSender(e))throw Error('来源不符');if(!['x','y','width','height'].every(k=>Number.isFinite(b?.[k]))||b.width<0||b.height<0)throw Error('业务视图边界无效');bounds=Object.fromEntries(['x','y','width','height'].map(k=>[k,b[k]]));layout();});
  handle('desks:stop',async(e,id)=>{if(!rootSender(e))throw Error('来源不符');const result=await manager.stop(id);const view=views.get(id);if(view){view.webContents.close();win.contentView.removeChildView(view);readyViews.delete(view);views.delete(id);}if(active===id)win.webContents.send('desks:navigate',{id:'home'});return result;});
  handle('desks:logs',async(e,id)=>{if(!rootSender(e)||isRemote()||!['purchase','sales','overview'].includes(id))throw Error('仅主机可查看服务日志');const file=path.join(manager.config(id).dataDir,'integration-service.log');if(fs.existsSync(file))await shell.openPath(file);});
  handle('desks:child-open',(e,id)=>{if(!childSender(e)||!['overview','exporter'].includes(id))throw Error('来源不符');win.webContents.send('desks:navigate',{id});return {requested:true};});
  handle('desks:child-home',e=>{if(!childSender(e))throw Error('来源不符');win.webContents.send('desks:navigate',{id:'home'});});
  handle('desks:data-changed',e=>{if(!childSender(e))throw Error('来源不符');views.get('overview')?.webContents.send('desks:source-changed');return {ok:true};});
  win.on('resize',layout);win.on('restore',layout);win.on('minimize',layout);
  const registryDir=path.dirname(manager.registryFile);fs.mkdirSync(registryDir,{recursive:true});
  const hostFile=path.join(registryDir,'host.json'),requestFile=path.join(registryDir,'open-request.json');let last='';
  let advertised=false;
  const tick=()=>{
    if(isRemote()){if(advertised){try{if(JSON.parse(fs.readFileSync(hostFile,'utf8')).pid===process.pid)fs.unlinkSync(hostFile);}catch{}advertised=false;}return;}
    if(!advertised){fs.writeFileSync(hostFile,JSON.stringify({protocolVersion:2,pid:process.pid,updatedAt:Date.now()}));advertised=true;}
    try{const req=JSON.parse(fs.readFileSync(requestFile,'utf8'));if(req.id!==last&&req.createdAt>Date.now()-30000&&/^[a-zA-Z0-9-]+$/.test(req.batch)){last=req.id;win.show();win.focus();win.webContents.send('desks:navigate',{id:'purchase',route:'/integration-review.html?batch='+req.batch});}}catch{}
  };
  tick();const timer=setInterval(tick,5000);timer.unref();
  win.on('closed',()=>{clearInterval(timer);for(const name of handlers)ipcMain.removeHandler(name);for(const v of views.values())if(!v.webContents.isDestroyed())v.webContents.close();try{if(JSON.parse(fs.readFileSync(hostFile,'utf8')).pid===process.pid)fs.unlinkSync(hostFile);}catch{}});
  const invalidate=id=>{const view=views.get(id);if(!view)return;if(active===id)hide();view.webContents.close();win.contentView.removeChildView(view);readyViews.delete(view);views.delete(id);};
  return {open,hide,manager,invalidate,reset:()=>{hide();for(const id of [...views.keys()])invalidate(id);}};
}
