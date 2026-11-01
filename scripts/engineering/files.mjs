import fs from 'node:fs';
import path from 'node:path';

/** Physical files only. Hardlinks avoid copying immutable dependency bytes;
 * cross-volume or restricted systems use ordinary copies. Never junctions. */
export function cloneFiles(source,target){
  fs.mkdirSync(target,{recursive:true});
  for(const entry of fs.readdirSync(source,{withFileTypes:true})){
    if(entry.name==='.bin')continue;
    const from=path.join(source,entry.name),to=path.join(target,entry.name);
    if(entry.isSymbolicLink())throw Error('Linked build input: '+from);
    if(entry.isDirectory())cloneFiles(from,to);
    else if(entry.isFile()){
      try{if(entry.name==='.package-lock.json')fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);else fs.linkSync(from,to);}catch(error){if(!['EXDEV','EPERM','EACCES','ENOTSUP','EMLINK'].includes(error.code))throw error;fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);}
    }else throw Error('Unsupported build file');
  }
}

export function pruneDeploymentMaps(root){
  let files=0,bytes=0;
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Linked deployment input');
    if(entry.isDirectory()){if(entry.name!=='.bin')walk(file);}
    else if(entry.isFile()&&/\.(?:map|pyc)$/.test(entry.name)){bytes+=fs.statSync(file).size;fs.unlinkSync(file);files++;}
  }}walk(root);return {files,bytes};
}
