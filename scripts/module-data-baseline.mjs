// Local-only evidence. Never upload the generated baseline or ledger backups.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const [mode,file]=process.argv.slice(2);
if(!['snapshot','verify'].includes(mode)||!file)throw Error('snapshot|verify ABSOLUTE_BASELINE_JSON');
const manager=new ServiceManager();
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v);
const ignored=new Set(['usage','launches','mobile_sessions','meta','sqlite_sequence']);
async function capture(withBackups){
  const databases=[],files=[];
  for(const id of ['warehouse','purchase','sales','overview','exporter']){
    const c=manager.config(id),database=path.join(c.dataDir,id==='exporter'?'orders.sqlite':c.db);
    if(!fs.existsSync(database))throw Error('Missing existing ledger for '+id);
    const db=new DatabaseSync(database,{readOnly:true}),tables={};
    try{
      if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error(id+' integrity failed');
      if(withBackups)await backup(db,path.join(path.dirname(file),id+'.sqlite'));
      db.exec('BEGIN');
      for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
        if(ignored.has(name))continue;
        const q='"'+name.replaceAll('"','""')+'"',s=db.prepare('SELECT * FROM '+q);s.setReadBigInts(true);
        const rows=s.all().map(json).sort();tables[name]={count:rows.length,digest:hash(json(rows))};
      }
      databases.push({id,path:database,tables});
    }finally{db.close();}
    const selected=id==='warehouse'?['settings.json','secrets.bin']:id==='exporter'?['Partitions']:
      ['originals','attachments','images','taobao-source','config.json','server.port'];
    const walk=relative=>{
      const target=path.join(c.dataDir,relative);if(!fs.existsSync(target))return;
      const stat=fs.lstatSync(target);if(stat.isSymbolicLink())throw Error('Unexpected data symlink');
      if(stat.isDirectory()){for(const n of fs.readdirSync(target))walk(path.join(relative,n));return;}
      if(id==='exporter'){
        if(path.basename(target)!=='Cookies')return;
        const cookie=new DatabaseSync(target,{readOnly:true});
        try{
          const values=cookie.prepare('SELECT host_key,name,path,encrypted_value,value FROM cookies ORDER BY host_key,name,path').all();
          files.push({id,relative,digest:hash(json(values)),count:values.length});
        }finally{cookie.close();}
      }else files.push({id,relative,digest:hash(fs.readFileSync(target)),bytes:stat.size});
    };
    selected.forEach(walk);
  }
  return {databases,files};
}
if(mode==='snapshot'){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file))throw Error('Baseline already exists');
  const value=await capture(true);fs.writeFileSync(file,JSON.stringify(value,null,2));
  console.log(JSON.stringify({ok:true,databases:value.databases.map(d=>({id:d.id,tables:Object.keys(d.tables).length})),files:value.files.length}));
}else{
  const before=JSON.parse(fs.readFileSync(file,'utf8')),after=await capture(false),differences=[];
  for(const db of before.databases){
    const current=after.databases.find(d=>d.id===db.id);
    for(const [table,value] of Object.entries(db.tables)){
      if(json(current.tables[table])!==json(value))differences.push({id:db.id,table,before:value.count,after:current.tables[table]?.count});
    }
  }
  for(const f of before.files)if(after.files.find(n=>n.id===f.id&&n.relative===f.relative)?.digest!==f.digest)differences.push({id:f.id,file:f.relative});
  const result={ok:!differences.length,databases:before.databases.length,files:before.files.length,differences,checkedAt:new Date().toISOString()};
  fs.mkdirSync('dist/module-verification',{recursive:true});fs.writeFileSync('dist/module-verification/data-preservation.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}
