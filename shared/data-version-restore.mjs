import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync,constants} from 'node:sqlite';
import {DATA_VERSION_POLICY,quoteIdentifier as qi} from './data-version-policy.mjs';
import {dataVersionDigest,safeDataVersionPath} from './data-version-capture.mjs';

/** Restore into a new isolated directory only; never replace an existing ledger. */
export function restoreDataVersion(options,target){
 const {event,eventDir,destination}=typeof options==='string'?{event:JSON.parse(fs.readFileSync(safeDataVersionPath(options,'event.json'),'utf8')),eventDir:options,destination:target}:options;
 safeDataVersionPath(path.dirname(path.resolve(destination)),path.basename(destination));
 if(fs.existsSync(destination))throw Error('Restore destination already exists');
 const policy=DATA_VERSION_POLICY[event?.module];if(!policy)throw Error('Unknown snapshot module');
 const bytes=fs.readFileSync(safeDataVersionPath(eventDir,event.snapshot.path));if(dataVersionDigest(bytes)!==event.snapshot.sha256)throw Error('Snapshot digest mismatch');
 const snapshot=JSON.parse(bytes,(_k,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&v.$blob!==undefined?Buffer.from(v.$blob,'base64'):v&&typeof v==='object'&&Object.keys(v).length===1&&v.$integer!==undefined?BigInt(v.$integer):v);
 if(snapshot.module!==event.module||snapshot.schemaVersion!==1)throw Error('Snapshot schema mismatch');
 const attachments=(event.attachments||[]).map(a=>{if(!a.path.startsWith('attachments/'))throw Error('Invalid attachment path');const relative=a.path.slice('attachments/'.length);if(!policy.folders.includes(relative.split('/')[0]))throw Error('Invalid attachment path');safeDataVersionPath(destination,relative);const content=fs.readFileSync(safeDataVersionPath(eventDir,a.path));if(content.length!==a.bytes||dataVersionDigest(content)!==a.sha256)throw Error('Attachment digest mismatch');return {relative,content};});
 const manifestPaths=new Set(attachments.map(item=>item.relative));
 for(const [table,rows]of Object.entries(snapshot.tables))for(const row of rows)for(const column of policy.files[table]||[]){if(!row[column])continue;safeDataVersionPath(destination,row[column]);if(!manifestPaths.has(row[column]))throw Error('Referenced attachment is missing from manifest');}
 const parent=path.dirname(path.resolve(destination));fs.mkdirSync(parent,{recursive:true});const temporary=path.join(parent,'.data-version-restore-'+randomUUID());fs.mkdirSync(temporary);let db;
 try{
  const databasePath=path.join(temporary,policy.database);db=new DatabaseSync(databasePath);if(typeof db.setAuthorizer!=='function')throw Error('Isolated restore requires Node.js >=24.18 with SQLite authorizer support');db.setAuthorizer(action=>[constants.SQLITE_ATTACH,constants.SQLITE_DETACH].includes(action)?constants.SQLITE_DENY:constants.SQLITE_OK);db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');
  for(const schema of snapshot.schema.filter(s=>s.type==='table')){if(!policy.tables.includes(schema.name))throw Error('Table outside business whitelist');restoreSchemaObject(db,schema);}
  for(const [table,rows]of Object.entries(snapshot.tables)){if(!policy.tables.includes(table))throw Error('Table outside business whitelist');for(const row of rows){if(table==='settings'&&!policy.settings.includes(row.key))throw Error('Setting outside business whitelist');const keys=Object.keys(row);db.prepare(`INSERT INTO ${qi(table)}(${keys.map(qi).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}}
  for(const row of snapshot.sequences||[]){if(!policy.tables.includes(row.name)||!Number.isSafeInteger(row.seq)||row.seq<0)throw Error('Invalid business sequence');db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(row.name);db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);}
  for(const schema of snapshot.schema.filter(s=>s.type!=='table'))restoreSchemaObject(db,schema);
  const violations=db.prepare('PRAGMA foreign_key_check').all();if(violations.length)throw Error('Restored snapshot has foreign key violations');db.exec(`PRAGMA user_version=${Number(snapshot.userVersion)||0};COMMIT`);db.close();db=null;
  for(const a of attachments){const target=safeDataVersionPath(temporary,a.relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,a.content,{flag:'wx'});}
  fs.renameSync(temporary,destination);return {databasePath:path.join(path.resolve(destination),policy.database),destination:path.resolve(destination)};
 }catch(e){try{db?.close();}catch{}fs.rmSync(temporary,{recursive:true,force:true});throw e;}
}
function restoreSchemaObject(db,schema){
 if(typeof schema.sql!=='string'||!['table','index','view','trigger'].includes(schema.type))throw Error('Invalid restore schema');
 const declared=schema.sql.match(/^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`'\[]?([A-Za-z_][A-Za-z0-9_]*)["`'\]]?(?:\s|\()/i);
 if(!declared||declared[1].toLowerCase()!==schema.type||declared[2]!==schema.name)throw Error('Invalid restore schema DDL');
 const statement=db.prepare(schema.sql);if(statement.sourceSQL.trim()!==schema.sql.trim())throw Error('Restore schema must contain one DDL statement');statement.run();
}
