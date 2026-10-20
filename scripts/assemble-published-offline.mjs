import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {digest,verifyCatalog} from '../desktop/modules/package-format.mjs';
const directory=path.resolve('dist/modules'),release=path.resolve('dist/launcher-release');
const catalogFile=path.join(directory,'catalog.json');
const envelope=JSON.parse(fs.readFileSync(catalogFile,'utf8'));
assert.deepEqual(envelope,JSON.parse(fs.readFileSync('desktop/launcher/catalog.json','utf8')));
const catalog=verifyCatalog(envelope,JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8')),
  {hostVersion:'0.8.0',platform:'win32',arch:'x64'});
const specs=JSON.parse(Buffer.from(envelope.payload,'base64')).packages;
assert.equal(specs.length,7);
for(const spec of specs){
  catalog.compatible(spec);
  assert.equal(fs.statSync(path.join(directory,spec.archive)).size,spec.bytes);
  assert.equal(await digest(path.join(directory,spec.archive)),spec.sha256,spec.id);
}
const sums=new Map(fs.readFileSync(path.join(release,'SHA256SUMS.txt'),'utf8').trim().split(/\r?\n/).map(line=>{
  const [,sha,name]=line.match(/^([a-f0-9]{64})\s+(.+)$/);return [name,sha];
}));
for(const name of fs.readdirSync(release).filter(name=>/\.(exe|yml|blockmap)$/.test(name)&&name!=='builder-debug.yml')){
  assert.equal(await digest(path.join(release,name)),sums.get(name),'Verified launcher changed: '+name);
}
const zip=new yazl.ZipFile();
zip.addFile(catalogFile,'catalog.json');
for(const spec of specs)zip.addFile(path.join(directory,spec.archive),spec.archive,{compress:false});
zip.end();
await pipeline(zip.outputStream,fs.createWriteStream(path.join(directory,'LingtuModules-Complete-Offline.zip')));
fs.mkdirSync('dist/module-verification',{recursive:true});
console.log(JSON.stringify({ok:true,signedModulePackages:7,launcherChecksumsPreserved:true}));
