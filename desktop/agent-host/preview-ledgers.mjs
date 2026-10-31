import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assertPreviewPaths,assertAgentRegistry} from './isolation.mjs';

const ledgers={warehouse:'workspace/data/erp.sqlite',purchase:'purchases.sqlite',sales:'sales.sqlite',overview:'overview.sqlite',exporter:'orders.sqlite'};
function noLinks(file){let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('预览账本路径包含链接');}}
function resource(root,rel){const file=path.resolve(root,rel),inside=path.relative(root,file);if(!inside||inside==='..'||inside.startsWith('..'+path.sep)||path.isAbsolute(inside))throw Error('预览初始化资源越界');noLinks(file);if(!fs.statSync(file).isFile())throw Error('预览初始化资源缺失');return pathToFileURL(file).href;}

// This is the only empty-ledger initialization branch. The normal managed
// service guard remains unchanged and still requires an existing database.
export function initializePreviewLedgers({paths,resourcesDir}={}){
  assertPreviewPaths(paths);const registry=assertAgentRegistry(paths),res=path.resolve(resourcesDir||'');noLinks(res);
  const node=registry.purchase.nodePath;noLinks(node);if(!fs.statSync(node).isFile())throw Error('预览固定 Node 环境未准备');
  fs.mkdirSync(paths.data,{recursive:true});const created=[];
  for(const [id,name] of Object.entries(ledgers)){
    const target=path.join(paths.data,id),database=path.join(target,...name.split('/'));noLinks(database);
    if(fs.existsSync(database)){if(!fs.statSync(database).isFile())throw Error('预览账本不是普通文件');continue;}
    if(fs.existsSync(target)){if(!fs.statSync(target).isDirectory()||fs.readdirSync(target).length)throw Error('预览目录已有文件但缺少账本，已保留现场：'+id);fs.rmdirSync(target);}
    const staging=fs.mkdtempSync(path.join(paths.data,'.preview-'+id+'-'));
    let code;
    if(['purchase','sales','overview'].includes(id)){const entry=resource(res,'workbench-gateway/apps/'+id+'/lib/'+(id==='sales'?'db.mjs':'store.mjs'));code=`const {openStore}=await import(${JSON.stringify(entry)});const store=openStore(process.env.LINGTU_PREVIEW_LEDGER_DIR);store.close();`;}
    else if(id==='warehouse'){const entry=resource(res,'workbench-gateway/core/erp/db.js');code=`const {getDb,closeDb}=await import(${JSON.stringify(entry)});getDb();closeDb();`;}
    else{const entry=resource(res,'apps/exporter/out/main/preview-ledger.js');code=`const {initializeEmptyPreviewExporter}=await import(${JSON.stringify(entry)});initializeEmptyPreviewExporter(process.env.LINGTU_PREVIEW_LEDGER_DIR);`;}
    const result=spawnSync(node,['--input-type=module','-e',code],{cwd:res,env:{...process.env,LINGTU_AGENT_PREVIEW:'1',LINGTU_PREVIEW_LEDGER_DIR:staging,CAINIAO_APP_DATA_DIR:path.join(staging,'workspace'),ERP_DATA_DIR:path.join(staging,'workspace','data')},encoding:'utf8',windowsHide:true,shell:false,timeout:60000,maxBuffer:1024*1024});
    if(result.status!==0||!fs.existsSync(path.join(staging,...name.split('/'))))throw Error('预览空账本初始化失败，原目录未覆盖：'+id+(result.error?' · '+result.error.code:''));
    noLinks(staging);fs.renameSync(staging,target);created.push(id);
  }
  return {created};
}
