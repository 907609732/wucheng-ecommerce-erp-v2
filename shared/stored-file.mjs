import fs from 'node:fs';
import path from 'node:path';
import {safeDataVersionPath} from './data-version-capture.mjs';

const invalid=(message,status=400)=>Object.assign(Error(message),{status});

// Interpret stored relative paths at read time only. Never rewrite a ledger or
// snapshot: Windows separators designate the same portable physical original.
export function resolveStoredFile(root,value,{folders}={}){
 if(typeof value!=='string'||path.posix.isAbsolute(value)||path.win32.isAbsolute(value)||/[\u0000-\u001f:]/.test(value))throw invalid('原件引用路径无效');
 const relative=value.replaceAll('\\','/');
 let file;try{file=safeDataVersionPath(root,relative);}catch{throw invalid('原件引用路径无效');}
 if(folders&&!folders.includes(relative.split('/')[0]))throw invalid('原件引用目录无效');
 try{if(!fs.lstatSync(file).isFile())throw Error();}catch{throw invalid('原件引用缺失或不是普通文件',404);}
 return {file,relative};
}
