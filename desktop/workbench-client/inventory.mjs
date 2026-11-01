import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {MODULE_IDS} from './connection.mjs';
const operational=new Set(['usage','launches','meta','settings','sessions','mobile_sessions','mobile_requests','requests']);
export function inspectLocalLedgers(services){
  return MODULE_IDS.map(module=>{
    const config=services.config(module),database=path.join(config.dataDir,config.db||'orders.sqlite');
    if(!fs.existsSync(database))return {module,present:false,records:0};
    const db=new DatabaseSync(database,{readOnly:true});
    try{
      const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
      const counts=Object.fromEntries(names.map(table=>[table,Number(db.prepare('SELECT COUNT(*) AS n FROM "'+table.replaceAll('"','""')+'"').get().n)]));
      // An empty main ledger may still contain real freight, bills, suppliers or
      // originals. Count every non-operational table; unknown tables fail closed.
      const selected=names.filter(t=>!operational.has(t)&&!t.startsWith('workbench_'));
      const records=selected.reduce((n,t)=>n+counts[t],0);
      return {module,present:true,records,schema:crypto.createHash('sha256').update(JSON.stringify(names.sort())).digest('hex'),counts,bytes:fs.statSync(database).size};
    }finally{db.close();}
  });
}
export async function backupLocalLedgers(services,root){
  const dest=path.join(root,'client-migration-source',new Date().toISOString().replaceAll(':','-'));fs.mkdirSync(dest,{recursive:true});
  const inventory=inspectLocalLedgers(services);
  for(const row of inventory.filter(v=>v.present)){
    const cfg=services.config(row.module),source=path.join(cfg.dataDir,cfg.db||'orders.sqlite'),db=new DatabaseSync(source,{readOnly:true});
    try{await backup(db,path.join(dest,row.module+'.sqlite'));}finally{db.close();}
    for(const prefix of ['attachments','originals','images','taobao-source','config.json','settings.json','server.port']){
      const source=path.join(cfg.dataDir,prefix);if(fs.existsSync(source))fs.cpSync(source,path.join(dest,row.module,prefix),{recursive:true,filter:file=>{if(fs.lstatSync(file).isSymbolicLink())throw Error('源资料包含链接，请先核对真实路径');return true;}});
    }
  }
  fs.writeFileSync(path.join(dest,'inventory.json'),JSON.stringify(inventory,null,2));return {directory:dest,inventory};
}
