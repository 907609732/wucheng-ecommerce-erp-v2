import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const hostError=(code,message,statusCode=400)=>Object.assign(Error(message),{code,statusCode,workbenchPublic:true});
export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}
  finally{fs.rmSync(temporary,{force:true});}
}
export function inside(root,target){const relative=path.relative(path.resolve(root),path.resolve(target));return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
export function assertPrivateFile(root,file){
  if(!inside(root,file))throw hostError('FILE_SCOPE_DENIED','文件不在本次任务的存储范围内',403);
  const stat=fs.lstatSync(file),realRoot=fs.realpathSync(root),real=fs.realpathSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!inside(realRoot,real))throw hostError('FILE_SCOPE_DENIED','文件来源已改变，请重新生成结果',403);
  return {file:real,stat};
}
