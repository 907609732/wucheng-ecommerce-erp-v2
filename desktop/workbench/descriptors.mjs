// Pure operation metadata; no database, UI, collector or filesystem imports.
export const exporterAdapter={
  id:'exporter',basePath:'/api/integration/v1/workbench',
  ui:{indexPath:'/api/integration/v1/workbench/ui',prefix:'/api/integration/v1/workbench/ui'},
  operations:[
    ['GET','/state','read'],['GET','/requests/:id','read'],['GET','/tasks/:id','read'],['GET','/tasks/:id/orders','read'],['GET','/tasks/:id/snapshot','read'],['GET','/logs/:platform','read'],
    ['POST','/tasks','write'],...['pause','resume','retry','finish','enrichDetails'].map(action=>['POST','/tasks/:id/'+action,'write']),
    ['POST','/host-action','write'],['POST','/tasks/:id/export','read'],['GET','/files/:id','download'],['POST','/tasks/:id/transfer','write'],['POST','/platforms/:platform/clear','confirmation'],
    ['GET','/ui','ui'],['GET','/ui/app.js','ui'],['GET','/ui/app.css','ui']
  ].map(([method,path,kind])=>({module:'exporter',method,path,kind,remote:true,operationId:'exporter.'+method.toLowerCase()+'.'+path.replaceAll('/','.').replaceAll(':',''),...(path.endsWith('/clear')?{uiOnly:true}:{})})),
  hostOnly:['login.partition','proxy.start','proxy.stop','proxy.certificate','proxy.settings','output.directory','logs.directory','module.update','module.install','module.stop','settings.secrets']
};
export const warehouseAdapter={
  id:'warehouse',basePath:'/api/integration/v1/workbench',
  ui:{indexPath:'/api/integration/v1/workbench/ui',prefix:'/api/integration/v1/workbench/ui'},
  operations:[['GET','/state','read'],['GET','/requests/:id','read'],['GET','/inventory','read'],['GET','/monthly-sales','read'],['GET','/task','read'],['GET','/logs','read'],['POST','/jobs','write'],['POST','/jobs/stop','write'],['POST','/host-action','write'],['POST','/send-latest-valid','write'],['GET','/daily','read'],['POST','/daily/action','write'],['POST','/daily/config','write'],['POST','/daily/remind','write'],['GET','/ui','ui'],['GET','/ui/app.js','ui'],['GET','/ui/app.css','ui']]
    .map(([method,path,kind])=>({module:'warehouse',method,path,kind,remote:true,operationId:'warehouse.'+method.toLowerCase()+'.'+path.slice(1).replaceAll('/','.'),...(method==='POST'&&!path.startsWith('/daily/')?{canRunTasks:true}:{}),...(path.startsWith('/daily/')?{uiOnly:true}:{})})),
  hostOnly:['settings.secrets','settings.browser','module.install','module.update','module.stop','backup.restore','output.directory','login.partition']
};
export const createExporterAdapter=()=>structuredClone(exporterAdapter);
export const createWarehouseAdapter=()=>structuredClone(warehouseAdapter);
