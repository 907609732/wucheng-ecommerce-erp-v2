import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {ZipFile} from 'yazl';

export async function zipFiles(root,files,output){
  const zip=new ZipFile();let bytes=0;
  for(const relative of [...files].sort()){
    const file=path.resolve(root,...relative.split('/')),rel=path.relative(root,file);
    if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())throw Error('Unsafe archive input: '+relative);
    bytes+=fs.statSync(file).size;
    zip.addFile(file,relative,{mtime:new Date('2020-01-01T00:00:00Z'),compressionLevel:6});
  }
  zip.end();await pipeline(zip.outputStream,fs.createWriteStream(output,{flags:'wx'}));return bytes;
}
