import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const baseline=process.argv[2];if(!baseline)throw Error('Provide the pre-change database-baseline.json');
const entries=JSON.parse(fs.readFileSync(baseline,'utf8')),base=path.dirname(baseline);
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?'bigint:'+v:v);
const q=x=>'"'+x.replaceAll('"','""')+'"';
const volatile=new Set(['usage','launches','mobile_sessions','meta','sqlite_sequence']);
const results=[];
for(const e of entries){
 if(!/[/\\](purchases|sales|overview|orders|erp)\.sqlite$/.test(e.source))continue;
 const a=new DatabaseSync(e.backup,{readOnly:true}),b=new DatabaseSync(e.source,{readOnly:true});a.exec('BEGIN');b.exec('BEGIN');
 const tables=[];try{
  for(const table of Object.keys(e.counts)){
   if(volatile.has(table))continue;
   const read=db=>{const s=db.prepare('SELECT * FROM '+q(table));s.setReadBigInts(true);return s.all().map(json).sort();};
   const before=read(a),after=read(b);tables.push({table,before:before.length,after:after.length,unchanged:hash(json(before))===hash(json(after))});
  }
  results.push({database:e.source,integrity:b.prepare('PRAGMA integrity_check').get().integrity_check,tables});
 }finally{a.close();b.close();}
}
const files=[];
for(const [backupName,source,folders] of [
 ['purchase-data',path.dirname(entries.find(e=>e.source.endsWith('purchases.sqlite')).source),['originals','attachments','images','taobao-source']],
 ['sales-data',path.dirname(entries.find(e=>e.source.endsWith('sales.sqlite')).source),['originals']],
 ['overview-data',path.dirname(entries.find(e=>e.source.endsWith('overview.sqlite')).source),['originals','downloads']]
]){
 let checked=0;const differences=[];
 const walk=(backup,relative='')=>{if(!fs.existsSync(backup))return;for(const item of fs.readdirSync(backup,{withFileTypes:true})){const rel=path.join(relative,item.name),file=path.join(backup,item.name);if(item.isDirectory())walk(file,rel);else{checked++;const live=path.join(source,rel);if(!fs.existsSync(live)||hash(fs.readFileSync(file))!==hash(fs.readFileSync(live)))differences.push(rel);}}};
 for(const folder of folders)walk(path.join(base,backupName,folder),folder);
 files.push({scope:backupName,checked,differences});
}
// Compare cookie identities and encrypted values without exposing them or their hashes.
const cookies=[];
const profile=path.join(base,'exporter-profile','Partitions');
if(fs.existsSync(profile))for(const part of fs.readdirSync(profile)){
 const backup=path.join(profile,part,'Network','Cookies'),live=path.join(path.dirname(entries.find(e=>e.source.endsWith('orders.sqlite')).source),'Partitions',part,'Network','Cookies');
 if(!fs.existsSync(backup))continue;
 let a,b;try{a=new DatabaseSync(backup,{readOnly:true});b=new DatabaseSync(live,{readOnly:true});const sql='SELECT host_key,name,path,encrypted_value,value FROM cookies ORDER BY host_key,name,path',before=a.prepare(sql).all(),after=b.prepare(sql).all();cookies.push({partition:part,before:before.length,after:after.length,unchanged:hash(json(before))===hash(json(after))});}catch(e){cookies.push({partition:part,error:e.message});}finally{a?.close();b?.close();}
}
const ok=results.every(r=>r.integrity==='ok'&&r.tables.every(t=>t.unchanged))&&files.every(f=>!f.differences.length)&&cookies.every(c=>c.unchanged);
const report={ok,checkedAt:new Date().toISOString(),results,files,cookies,excludedRuntimeTables:[...volatile]};
fs.mkdirSync('dist/integration-verification',{recursive:true});fs.writeFileSync('dist/integration-verification/data-preservation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({ok,databases:results.map(r=>({database:path.basename(r.database),tables:r.tables.length,differences:r.tables.filter(t=>!t.unchanged)})),files,cookies}));
if(!ok)process.exitCode=1;
