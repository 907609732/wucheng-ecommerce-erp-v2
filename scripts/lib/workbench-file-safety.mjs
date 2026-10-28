import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const folded=value=>path.resolve(value).toLowerCase();
export const samePath=(a,b)=>folded(a)===folded(b);
export const inside=(base,target)=>folded(target).startsWith(folded(base)+path.sep);
export const hashFile=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Missing leaf paths are resolved through their nearest existing ancestor.
// Aliases/junctions are rejected, including links in a parent directory.
export function physicalPath(value,{allowMissing=false}={}){
  const absolute=path.resolve(value);let ancestor=absolute,tail=[];
  while(!fs.existsSync(ancestor)){
    if(!allowMissing)throw Error('需要核对的路径不存在');
    const parent=path.dirname(ancestor);if(parent===ancestor)throw Error('路径没有可核对的现有父目录');
    tail.unshift(path.basename(ancestor));ancestor=parent;
  }
  const physical=path.join(fs.realpathSync.native(ancestor),...tail);
  if(!samePath(absolute,physical)||fs.lstatSync(ancestor).isSymbolicLink())throw Error('路径包含链接或重定向，请先核对物理位置');
  return absolute;
}

export function externalArchive(projectRoot,archive){
  const root=physicalPath(projectRoot),target=physicalPath(archive,{allowMissing:true});
  if(samePath(root,target)||inside(root,target)||inside(target,root))throw Error('归档必须位于工程外，不能等于或包含工程根目录');
  return target;
}

export function verifyTreeWithoutLinks(target){
  physicalPath(target);
  if(!fs.statSync(target).isDirectory())return;
  for(const item of fs.readdirSync(target,{withFileTypes:true})){
    const file=path.join(target,item.name);
    if(item.isSymbolicLink())throw Error('清理或归档目录包含链接，请先核对');
    if(item.isDirectory())verifyTreeWithoutLinks(file);
  }
}

export function verifyDeletionTarget(target,{base,protectedRoots=[],protectedTrees=[]}){
  const physical=physicalPath(target),root=physicalPath(base);
  if(!inside(root,physical))throw Error('删除目标不在明确允许目录内，或等于允许目录根');
  if(protectedRoots.some(p=>samePath(p,physical)||inside(physical,p))||protectedTrees.some(p=>samePath(p,physical)||inside(physical,p)||inside(p,physical)))throw Error('删除目标触及受保护路径');
  verifyTreeWithoutLinks(physical);return physical;
}

export function managedProgramProtection(target,{kind,profile,currentRoots=[],programRoots=[],authRoots=[],dataRoots=[],protectedTrees=[],activeReference=false}){
  if(kind!=='retired-managed-program'||activeReference)return protectedTrees;
  const physical=physicalPath(target),profileRoot=physicalPath(profile),store=physicalPath(path.join(profileRoot,'modules','packages'));
  const parts=path.relative(store,physical).split(path.sep);
  const allowed=new Set(['warehouse','purchase','sales','overview','exporter','node-runtime','browser-runtime']);
  if(parts.length!==2||!allowed.has(parts[0])||!/^\d+\.\d+\.\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parts[1]))return protectedTrees;
  if(currentRoots.some(p=>samePath(p,physical)||inside(p,physical)||inside(physical,p)))return protectedTrees;
  if(!authRoots.some(p=>samePath(p,profileRoot))||dataRoots.some(p=>samePath(p,profileRoot))||programRoots.some(p=>samePath(p,profileRoot)))return protectedTrees;
  verifyTreeWithoutLinks(physical);
  // Only the broad authentication parent is ignored. Dedicated data/program
  // roots and every more-specific authentication subtree retain their fence.
  return protectedTrees.filter(p=>!samePath(p,profileRoot));
}

export function verifySourceReplacement({source,sourceRoot,replacement,replacementRoot,backup,backupRoot,sha256}){
  for(const [file,base] of [[source,sourceRoot],[replacement,replacementRoot],[backup,backupRoot]]){
    const physical=physicalPath(file),root=physicalPath(base);
    if(!inside(root,physical)||!fs.statSync(physical).isFile())throw Error('源码、接管副本或备份越过明确范围');
  }
  if(hashFile(source)!==sha256||hashFile(backup)!==sha256)throw Error('旧源码或原始备份摘要不符');
}

export function archiveVerified(source,target,files=[]){
  physicalPath(source);physicalPath(target,{allowMissing:true});
  const stat=fs.lstatSync(source);
  if(stat.isDirectory()){
    fs.mkdirSync(target,{recursive:true});physicalPath(target);
    for(const name of fs.readdirSync(source))archiveVerified(path.join(source,name),path.join(target,name),files);
  }else{
    if(!stat.isFile())throw Error('历史资料不是普通文件');
    const sha256=hashFile(source);fs.mkdirSync(path.dirname(target),{recursive:true});physicalPath(path.dirname(target));
    if(fs.existsSync(target)&&(!fs.statSync(target).isFile()||hashFile(target)!==sha256))throw Error('归档目标已有不同内容，已保留原件');
    if(!fs.existsSync(target))fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
    physicalPath(target);
    if(hashFile(target)!==sha256||hashFile(source)!==sha256)throw Error('历史资料归档摘要不符或源文件正在变化');
    files.push({source,target,sha256,bytes:stat.size});
  }
  return files;
}

export function refersToScope(processRow,scope){
  const normalize=value=>String(value||'').replaceAll('/',path.sep).toLowerCase();
  const target=normalize(path.resolve(scope)),executable=normalize(processRow.ExecutablePath),command=normalize(processRow.CommandLine);
  return executable===target||executable.startsWith(target+path.sep)||command.includes(target+path.sep)||command.includes('"'+target+'"')||command.startsWith(target+' ');
}
