import {backup,DatabaseSync} from 'node:sqlite';
import {mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {id,now,hash,fail} from './util.mjs';

export async function makeBackup(s,reason='manual') {
  const name=now().replace(/[:.]/g,'-')+'-'+id().slice(0,8),dest=path.join(s.dir,'backups',name);mkdirSync(dest,{recursive:true});
  const target=path.join(dest,'sales.sqlite');await backup(s.db,target);
  const snap=new DatabaseSync(target,{readOnly:true});const originals=[...new Set([...snap.prepare('SELECT DISTINCT original_path FROM imports').all().map(x=>x.original_path),...snap.prepare('SELECT payload FROM platform_references').all().map(x=>JSON.parse(x.payload).evidence_path).filter(Boolean)])];const reports=[...snap.prepare("SELECT detail FROM jobs WHERE state IN ('complete','needs_action')").all().map(r=>JSON.parse(r.detail).file).filter(Boolean),...readdirSync(path.join(s.dir,'reports')).filter(x=>/\.(xlsx|json)$/i.test(x))];snap.close();
  const freightSnapshot=new DatabaseSync(target,{readOnly:true});
  try{if(freightSnapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='freight_attachments'").get())originals.push(...freightSnapshot.prepare('SELECT DISTINCT original_path FROM freight_attachments').all().map(x=>x.original_path));}finally{freightSnapshot.close();}
  const retained=[],evidenceSnapshot=new DatabaseSync(target,{readOnly:true});
  try{
    if(evidenceSnapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_artifacts'").get())retained.push(...evidenceSnapshot.prepare("SELECT path FROM agent_artifacts WHERE json_extract(grant_json,'$.kind')='source'").all().map(row=>row.path));
    if(evidenceSnapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales_cainiao_files'").get())retained.push(...evidenceSnapshot.prepare('SELECT path FROM sales_cainiao_files').all().map(row=>row.path));
  }finally{evidenceSnapshot.close();}
  const bridgeRoot=path.join(s.dir,'downloads','cainiao-artifacts');
  const retainTree=folder=>{if(lstatSync(folder).isSymbolicLink())throw fail('原件证据不能包含符号链接');for(const entry of readdirSync(folder,{withFileTypes:true})){const source=path.join(folder,entry.name);if(entry.isSymbolicLink())throw fail('原件证据不能包含符号链接');if(entry.isDirectory())retainTree(source);else if(entry.isFile())retained.push(path.relative(s.dir,source));}};
  if(existsSync(bridgeRoot))for(const m of readdirSync(bridgeRoot)){if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(m))continue;const monthDir=path.join(bridgeRoot,m);if(lstatSync(monthDir).isSymbolicLink()||!statSync(monthDir).isDirectory())throw fail('原件证据目录无效');for(const fingerprint of readdirSync(monthDir)){if(!/^[a-f0-9]{64}$/.test(fingerprint))continue;const folder=path.join(monthDir,fingerprint),manifestPath=path.join(folder,'manifest.json');if(!existsSync(manifestPath))continue;const sourceManifest=JSON.parse(readFileSync(manifestPath,'utf8'));if(hash(sourceManifest)!==fingerprint)throw fail('原件交接证据摘要不符');retainTree(folder);}}
  const files=[{path:'sales.sqlite',sha256:hash(readFileSync(target))}];
  for(const relative of originals){const source=path.resolve(s.dir,relative);if(!source.startsWith(path.resolve(s.dir,'originals')+path.sep))throw fail('原件路径无效');const p=path.join(dest,relative);mkdirSync(path.dirname(p),{recursive:true});copyFileSync(source,p);files.push({path:relative,sha256:hash(readFileSync(p))});}
  for(const file of new Set(reports)){if(path.basename(file)!==file)throw fail('报告路径无效');const relative=path.join('reports',file),source=path.join(s.dir,relative);if(!existsSync(source))continue;const p=path.join(dest,relative);mkdirSync(path.dirname(p),{recursive:true});copyFileSync(source,p);files.push({path:relative,sha256:hash(readFileSync(p))});}
  for(const relative of new Set(retained)){const source=path.resolve(s.dir,relative),root=path.resolve(s.dir);if(!source.startsWith(root+path.sep)||!['agent-artifacts','downloads'].some(folder=>source.startsWith(path.join(root,folder)+path.sep))||lstatSync(source).isSymbolicLink()||!realpathSync(source).startsWith(realpathSync(s.dir)+path.sep))throw fail('保留原件路径无效');const p=path.join(dest,relative);mkdirSync(path.dirname(p),{recursive:true});copyFileSync(source,p);files.push({path:relative,sha256:hash(readFileSync(p))});}
  writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({version:1,created_at:now(),reason,files},null,2));
  s.audit('backup.create',name,{reason,files:files.length});return {name,files:files.length};
}
export function verifyBackup(s,name) {
  if(!/^[\w.-]+$/.test(name))throw fail('备份名称无效');const dir=path.join(s.dir,'backups',name);
  const manifest=JSON.parse(readFileSync(path.join(dir,'manifest.json'),'utf8'));
  for(const f of manifest.files){const p=path.resolve(dir,f.path);if(!p.startsWith(path.resolve(dir)+path.sep))throw fail('备份路径无效');if(hash(readFileSync(p))!==f.sha256)throw fail('备份文件校验失败：'+f.path);}
  const db=new DatabaseSync(path.join(dir,'sales.sqlite'),{readOnly:true});try{const check=db.prepare('PRAGMA integrity_check').get();if(check.integrity_check!=='ok')throw fail('备份数据库完整性检查失败');}finally{db.close();}
  return {ok:true,files:manifest.files.length,created_at:manifest.created_at};
}
export function restoreBackup(s,name,target) {
  const result=verifyBackup(s,name),dest=path.resolve(target);if(existsSync(dest))throw fail('恢复目录必须不存在，防止覆盖现有数据');
  const source=path.join(s.dir,'backups',name),manifest=JSON.parse(readFileSync(path.join(source,'manifest.json'),'utf8'));mkdirSync(dest,{recursive:true});
  for(const f of manifest.files){const p=path.join(dest,f.path);mkdirSync(path.dirname(p),{recursive:true});copyFileSync(path.join(source,f.path),p);}
  return {...result,path:dest};
}
export function listBackups(s){return readdirSync(path.join(s.dir,'backups')).filter(n=>existsSync(path.join(s.dir,'backups',n,'manifest.json'))).sort().reverse().map(name=>({name,...JSON.parse(readFileSync(path.join(s.dir,'backups',name,'manifest.json'),'utf8')),bytes:statSync(path.join(s.dir,'backups',name,'sales.sqlite')).size}));}
