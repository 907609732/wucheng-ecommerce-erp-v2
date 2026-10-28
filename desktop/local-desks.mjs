import {WebContentsView,ipcMain,shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ServiceManager} from './shared/service-manager.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export function installDeskViews(win,{manager=new ServiceManager(),notify=()=>{},includeWarehouse=false,isRemote=()=>false,partitionFor=id=>'persist:lingtu-'+id,beforeOpen=async()=>{},decorateURL=(_id,url)=>url}={}){
  const views=new Map();let active='',generation=0,bounds={x:12,y:140,width:1000,height:600};
  const rootSender=e=>e.sender===win.webContents&&e.senderFrame===win.webContents.mainFrame;
  const childSender=e=>[...views.values()].some(v=>e.sender===v.webContents&&e.senderFrame===v.webContents.mainFrame);
  const handlers=[];
  function handle(name,fn){ipcMain.handle(name,fn);handlers.push(name);}
  const layout=()=>{const size=win.getContentBounds();for(const v of views.values())v.setBounds({x:Math.max(0,bounds.x),y:Math.max(0,bounds.y),width:Math.max(100,Math.min(bounds.width,size.width-bounds.x)),height:Math.max(100,size.height-bounds.y-12)});};
  const hide=(cancel=true)=>{if(cancel)generation++;active='';for(const v of views.values())v.setVisible(false);};
  async function open(id,route){
    if(!['purchase','sales','overview',...(isRemote()?['warehouse','exporter']:[])].includes(id))throw Error('该扩展不支持内嵌打开');
    if(route&&!/^\/[a-zA-Z0-9/_-]+\.html(?:\?[a-zA-Z0-9%=&._-]+)?$/.test(route)||route?.includes('..'))throw Error('扩展页面无效');
    const mine=++generation;await beforeOpen(id);
    if(mine!==generation)return {cancelled:true};
    const cap=await manager.ensure(id);
    if(mine!==generation)return {cancelled:true};
    const targetURL=decorateURL(id,cap.url+(route||'/'));
    let view=views.get(id);
    if(!view){
      view=new WebContentsView({webPreferences:{preload:path.join(here,'extension-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:partitionFor(id)}});
      views.set(id,view);win.contentView.addChildView(view);view.setVisible(false);
      const external=url=>{if(/^https?:\/\//i.test(url))void shell.openExternal(url).catch(e=>notify(e.message));};
      const crossModule=url=>{
        if(!isRemote())return false;const target=new URL(url),base=new URL(cap.url);if(target.origin!==base.origin)return false;
        const match=target.pathname.match(/^\/apps\/(warehouse|purchase|sales|overview|exporter)(\/.*)$/);if(!match||match[1]===id)return false;
        win.webContents.send('desks:navigate',{id:match[1],...(match[2]!=='/'?{route:match[2]+target.search}:{})});return true;
      };
      view.webContents.setWindowOpenHandler(({url})=>{if(crossModule(url))return {action:'deny'};if(url.startsWith(cap.url+'/'))void view.webContents.loadURL(url).catch(e=>notify(e.message));else external(url);return {action:'deny'};});
      view.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(cap.url+'/')){event.preventDefault();if(!crossModule(url))external(url);}});
      view.webContents.on('render-process-gone',()=>notify(`${id} 页面意外退出，请重新打开`));
      view.webContents.session.on('will-download',(_e,item)=>{item.setSaveDialogOptions({title:'保存扩展导出文件'});});
      await view.webContents.loadURL(targetURL);
    }else if(route)await view.webContents.loadURL(targetURL);
    if(mine!==generation)return {cancelled:true};
    hide(false);active=id;layout();view.setVisible(true);view.webContents.focus();
    return {id,url:cap.url};
  }
  handle('desks:status',e=>{if(!rootSender(e))throw Error('来源不符');return manager.status({includeWarehouse});});
  handle('desks:open',(e,{id,route}={})=>{if(!rootSender(e))throw Error('来源不符');return open(id,route);});
  handle('desks:hide',e=>{if(!rootSender(e))throw Error('来源不符');hide();});
  handle('desks:bounds',(e,b)=>{if(!rootSender(e))throw Error('来源不符');if(['x','y','width'].every(k=>Number.isFinite(b?.[k]))){bounds={...bounds,...Object.fromEntries(['x','y','width'].map(k=>[k,Math.round(b[k])]))};layout();}});
  handle('desks:stop',async(e,id)=>{if(!rootSender(e))throw Error('来源不符');const result=await manager.stop(id);const view=views.get(id);if(view){view.webContents.close();win.contentView.removeChildView(view);views.delete(id);}if(active===id)win.webContents.send('desks:navigate',{id:'home'});return result;});
  handle('desks:logs',async(e,id)=>{if(!rootSender(e)||isRemote()||!['purchase','sales','overview'].includes(id))throw Error('仅主机可查看服务日志');const file=path.join(manager.config(id).dataDir,'integration-service.log');if(fs.existsSync(file))await shell.openPath(file);});
  handle('desks:child-open',(e,id)=>{if(!childSender(e)||!['overview','exporter'].includes(id))throw Error('来源不符');win.webContents.send('desks:navigate',{id});return {requested:true};});
  handle('desks:child-home',e=>{if(!childSender(e))throw Error('来源不符');win.webContents.send('desks:navigate',{id:'home'});});
  handle('desks:data-changed',e=>{if(!childSender(e))throw Error('来源不符');views.get('overview')?.webContents.send('desks:source-changed');return {ok:true};});
  win.on('resize',layout);
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
  const invalidate=id=>{const view=views.get(id);if(!view)return;if(active===id)hide();view.webContents.close();win.contentView.removeChildView(view);views.delete(id);};
  return {open,hide,manager,invalidate,reset:()=>{hide();for(const id of [...views.keys()])invalidate(id);}};
}
