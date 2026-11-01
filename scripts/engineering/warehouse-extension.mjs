import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {suiteSourceDigest} from '../suite-source-digests.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function warehouseSource(){
  const directory=path.resolve(process.env.LINGTU_WAREHOUSE_SOURCE||path.join(root,'../cainiao-inventory-codex/windows/workbench'));
  const descriptor=JSON.parse(fs.readFileSync(path.join(directory,'extension.json'),'utf8'));
  if(descriptor.id!=='warehouse'||descriptor.platform!=='win32'||descriptor.arch!=='x64')throw Error('Windows warehouse extension source identity invalid');
  return {directory,sha256:suiteSourceDigest(directory)};
}
export function overlayWarehouseSource(stage){
  const {directory}=warehouseSource();
  for(const name of ['core','desktop'])fs.cpSync(path.join(directory,name),path.join(stage,name),{recursive:true,filter:file=>{if(fs.lstatSync(file).isSymbolicLink())throw Error('Linked extension source');return fs.statSync(file).isDirectory()||deferredWarehouseFile(path.relative(directory,file).replaceAll('\\','/'));}});
}

import {deferredWarehouseFile} from '../../desktop/product/extension-layout.mjs';
export {deferredWarehouseFile};

/** Keep the installed host dependency closure, including nested/optional packages. */
export function hostDependencyPaths(lock){
  const keep=new Set(),packages=lock.packages;
  function visit(key){
    if(keep.has(key))return;const pkg=packages[key];if(!pkg)throw Error('Missing host locked dependency: '+key);keep.add(key);
    for(const name of Object.keys({...pkg.dependencies,...pkg.optionalDependencies})){
      let base=key,found;
      while(true){const candidate=(base?base+'/':'')+'node_modules/'+name;if(packages[candidate]){found=candidate;break;}if(!base)break;const split=base.lastIndexOf('/node_modules/');base=split<0?'':base.slice(0,split);}
      if(found)visit(found);else if(!pkg.optionalDependencies?.[name])throw Error('Unresolved host dependency: '+name);
    }
  }
  for(const name of ['@modelcontextprotocol/server','zod','fastify','@fastify/cookie','@fastify/reply-from','semver','yauzl'])visit('node_modules/'+name);
  return [...keep];
}
