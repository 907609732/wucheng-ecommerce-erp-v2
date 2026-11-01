import fs from 'node:fs';
import path from 'node:path';

/** Conservative distribution trimming: keep licenses, codecs and GPU fallback. */
export function trimShell(directory){
  const root=fs.realpathSync(directory),locales=path.join(root,'locales');let removedBytes=0,removedFiles=0;
  if(fs.lstatSync(locales).isSymbolicLink())throw Error('Redirected locales directory');
  for(const entry of fs.readdirSync(locales))if(entry.endsWith('.pak')&&!['zh-CN.pak','en-US.pak'].includes(entry)){
    const file=path.join(locales,entry),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid locale');removedBytes+=stat.size;removedFiles++;fs.unlinkSync(file);
  }
  return {removedBytes,removedFiles,preserved:['licenses','ffmpeg','icu','gpu-fallback']};
}
export function assertSlimShell(root){
  const locales=fs.readdirSync(path.join(root,'locales')).filter(f=>f.endsWith('.pak')).sort();
  if(JSON.stringify(locales)!==JSON.stringify(['en-US.pak','zh-CN.pak']))throw Error('Shell locales were not trimmed');
  for(const name of ['icudtl.dat','ffmpeg.dll','resources.pak','LICENSES.chromium.html'])if(!fs.statSync(path.join(root,name)).isFile())throw Error('Required shell resource missing: '+name);
  for(const name of ['apps','vendor','dependency-layers'])if(fs.existsSync(path.join(root,'resources/agent-runtime',name)))throw Error('Lightweight shell includes deferred components: '+name);
}
