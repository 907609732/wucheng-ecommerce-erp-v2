import fs from 'node:fs';
import path from 'node:path';
import {digest,verifyCatalog} from '../../desktop/modules/package-format.mjs';
import {physicalPath,samePath} from './workbench-file-safety.mjs';

function jsonFile(file,maxBytes){
  const physical=physicalPath(file),stat=fs.statSync(physical);
  if(!stat.isFile()||stat.size>maxBytes)throw Error('Vendor cache metadata is not a bounded regular file');
  return JSON.parse(fs.readFileSync(physical,'utf8'));
}

// Read-only selection: a present but damaged current pointer never falls back
// to older packages. Only an absent current pointer enables legacy bootstrap.
export async function selectSuiteVendorRuntimes({root=process.cwd(),hostVersion,publicKeys,platform='win32',arch='x64'}){
  const project=physicalPath(root),dist=physicalPath(path.join(project,'dist'));
  const pointerFile=path.join(dist,'suite-payload-current.json');
  let source,directory,pointer;
  if(fs.existsSync(pointerFile)){
    pointer=jsonFile(pointerFile,65536);
    if(typeof pointer.directory!=='string'||!path.isAbsolute(pointer.directory)||typeof pointer.version!=='string'||!/^[a-f0-9]{64}$/.test(pointer.catalogSha256||''))throw Error('Current suite vendor pointer is invalid');
    directory=physicalPath(pointer.directory);
    if(!samePath(path.dirname(directory),dist)||!/^suite-payload-[A-Za-z0-9_-]+$/.test(path.basename(directory))||!fs.statSync(directory).isDirectory())throw Error('Current suite vendor cache escapes the managed payload directory');
    source='current-suite';
  }else{
    // A dangling link must fail rather than be mistaken for a missing pointer.
    try{fs.lstatSync(pointerFile);throw Error('Current suite vendor pointer is an invalid link');}catch(error){if(error.code!=='ENOENT')throw error;}
    directory=physicalPath(path.join(dist,'modules'));source='legacy-modules';
  }
  const catalogFile=path.join(directory,'catalog.json'),envelope=jsonFile(catalogFile,4*1024*1024),catalogSha256=await digest(catalogFile);
  if(pointer&&catalogSha256!==pointer.catalogSha256)throw Error('Current suite vendor catalog digest mismatch');
  const catalog=verifyCatalog(envelope,publicKeys,{hostVersion,platform,arch});
  if(pointer&&(catalog.suite?.format!=='lingtu-suite/v1'||catalog.suite.productId!=='com.wucheng.ecommerce.erp.v2'||catalog.suite.version!==pointer.version))throw Error('Current suite vendor catalog identity does not match its pointer');
  const vendors=[];
  for(const id of ['node-runtime','browser-runtime']){
    const spec=catalog.packages.find(item=>item.id===id);
    if(!spec||spec.kind!=='runtime')throw Error('Verified vendor runtime is missing: '+id);
    catalog.compatible(spec);
    const file=physicalPath(path.join(directory,spec.archive));
    if(!samePath(path.dirname(file),directory)||!fs.statSync(file).isFile()||fs.statSync(file).size!==spec.bytes||await digest(file)!==spec.sha256)throw Error('Vendor runtime size or digest mismatch: '+id);
    vendors.push({spec,file});
  }
  return {source,directory,catalogFile,catalogSha256,vendors};
}
