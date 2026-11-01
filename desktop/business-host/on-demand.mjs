import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PRODUCT_MODULE_IDS,productModule} from '../product/modules.mjs';
import {digest,verifyCatalog,downloadPackage,extractZip,inside,fail} from '../modules/package-format.mjs';
import {atomicJson} from './common.mjs';
import {assertPreviewPaths} from './isolation.mjs';
import {createAgentActivation} from './activation.mjs';
import {verifyActivationResources} from './activation-resources.mjs';
import {betaProcessesRunning} from './startup.mjs';

function physical(file){
  let cursor=path.parse(file).root;
  for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);
    if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw fail('INVALID_PATH','组件缓存路径包含链接');
  }
}

/** Catalog and full payload manifest are pinned by the installed preview shell.
 * Downloaded bytes never supply an alternative catalog or a host-code overlay. */
export async function createOnDemandComponents({paths,resourcesDir,hostVersion,publicKeys,signal,onProgress=()=>{},fetchImpl=fetch,activate=createAgentActivation,isBusy=id=>betaProcessesRunning(paths,[id])}={}){
  assertPreviewPaths(paths);
  const descriptor=JSON.parse(fs.readFileSync(path.join(resourcesDir,'on-demand.json'),'utf8'));
  const manifestFile=path.join(resourcesDir,'agent-beta-resources.json');
  const pin=JSON.parse(fs.readFileSync(path.join(resourcesDir,'desktop/business-host/packaged-manifest.json'),'utf8'));
  if(descriptor.format!=='lingtu-on-demand/v1'||descriptor.version!==hostVersion||pin.sha256!==descriptor.manifestSha256||await digest(manifestFile)!==descriptor.manifestSha256)throw fail('INVALID_MANIFEST','按需组件清单与安装版本不符');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const envelopeFile=path.join(resourcesDir,'component-catalog.json');
  if(await digest(envelopeFile)!==descriptor.catalogSha256)throw fail('INVALID_CATALOG','按需组件目录摘要不符');
  const catalog=verifyCatalog(JSON.parse(fs.readFileSync(envelopeFile,'utf8')),publicKeys,{hostVersion,platform:'win32',arch:'x64'});
  if(catalog.releaseManifestSha256!==descriptor.manifestSha256||catalog.preview!==true||catalog.version!==hostVersion)throw fail('INVALID_CATALOG','组件目录没有绑定当前预览');
  for(const spec of catalog.packages)catalog.compatible(spec);
  const root=path.join(paths.root,'downloads',descriptor.manifestSha256),archives=path.join(root,'archives'),res=path.join(root,'resources');
  physical(root);physical(archives);physical(res);fs.mkdirSync(archives,{recursive:true});fs.mkdirSync(res,{recursive:true});
  physical(manifestFile);physical(path.join(res,'agent-beta-resources.json'));fs.copyFileSync(manifestFile,path.join(res,'agent-beta-resources.json'));
  // Verify only shipped host files here. Unused modules are absent by design.
  const hostManifest={...manifest,payloadHashes:Object.fromEntries(Object.entries(manifest.payloadHashes).filter(([rel])=>!rel.startsWith('apps/')&&!rel.startsWith('vendor/')&&!rel.startsWith('dependency-layers/')))};
  await verifyActivationResources(resourcesDir,hostManifest,{signal,onProgress});
  let queue=Promise.resolve();const pending=new Map(),controllers=new Map(),ready=new Set();
  async function materialize(spec,id,abort){
    abort.throwIfAborted();
    const space=fs.statfsSync(root);
    if(space.bavail*space.bsize<spec.bytes+spec.unpackedBytes+64*1024**2)throw fail('NO_SPACE','可用磁盘空间不足，原组件保持不变');
    const archive=path.join(archives,spec.sha256+'.part');physical(archive);
    onProgress({id,component:spec.id,phase:'downloading',received:fs.existsSync(archive)?fs.statSync(archive).size:0,total:spec.bytes});
    await downloadPackage(spec,archive,{signal:abort,fetchImpl,progress:value=>onProgress({id,component:spec.id,phase:'downloading',...value})});
    onProgress({id,component:spec.id,phase:'verify'});
    if(await digest(archive)!==spec.sha256){fs.unlinkSync(archive);throw fail('HASH_MISMATCH','组件摘要不符，请重试下载');}
    if(spec.kind==='runtime'){
      const target=inside(res,'vendor/'+spec.archive);physical(target);fs.mkdirSync(path.dirname(target),{recursive:true});
      if(!fs.existsSync(target))fs.copyFileSync(archive,target,fs.constants.COPYFILE_EXCL);
      if(await digest(target)!==spec.sha256)throw fail('HASH_MISMATCH','运行环境缓存已变化');
      return;
    }
    const prefix='apps/'+spec.id+'/',expected=Object.fromEntries(Object.entries(manifest.payloadHashes).filter(([rel])=>rel.startsWith(prefix)));
    if(!Object.keys(expected).length)throw fail('INVALID_MANIFEST','组件不在冻结资源清单中');
    const target=inside(res,'apps/'+spec.id);physical(target);
    if(fs.existsSync(target)){
      try{await verifyActivationResources(res,{...manifest,payloadHashes:expected},{signal:abort});return;}
      catch(error){abort.throwIfAborted();physical(target);fs.renameSync(target,target+'.corrupt-'+randomUUID());}
    }
    const stage=path.join(root,'extract-'+randomUUID());physical(stage);
    try{
      onProgress({id,component:spec.id,phase:'dependencies'});
      await extractZip(archive,stage,{maxBytes:spec.unpackedBytes,signal:abort});
      const actual=[];
      function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw fail('INVALID_PATH','组件包含链接');
        if(entry.isDirectory())walk(file);else actual.push(path.relative(stage,file).replaceAll('\\','/'));
      }}walk(stage);
      if(JSON.stringify(actual.sort())!==JSON.stringify(Object.keys(expected).sort()))throw fail('INVALID_MANIFEST','组件包含未登记文件或缺少文件');
      await verifyActivationResources(stage,{...manifest,payloadHashes:expected},{signal:abort});
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(inside(stage,'apps/'+spec.id),target);
    }finally{
      // Stage is an internally generated child, never a caller-supplied path.
      physical(stage);fs.rmSync(stage,{recursive:true,force:true});
    }
  }
  function ensure(id){
    if(!PRODUCT_MODULE_IDS.includes(id))return Promise.reject(fail('UNKNOWN_MODULE','未知业务模块'));
    if(ready.has(id))return Promise.resolve({ready:true,reused:true,installed:[id]});
    if(pending.has(id))return pending.get(id);
    const controller=new AbortController();controllers.set(id,controller);
    const abort=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
    const job=queue.then(async()=>{
      abort.throwIfAborted();
      const dependencies=productModule(id).dependencies;
      for(const key of [...dependencies,id]){
        const spec=catalog.packages.find(value=>value.id===key);if(!spec)throw fail('MISSING_DEPENDENCY','缺少匹配版本的组件：'+key);
        await materialize(spec,id,abort);
      }
      const previous=fs.readFileSync(paths.registryFile);
      try{
        const result=await activate({paths,resourcesDir:res,hostResourcesDir:resourcesDir,expectedManifestSha256:descriptor.manifestSha256,selectedModules:[id],isBusy:()=>isBusy(id),signal:abort,onProgress:value=>onProgress({id,...value})})();
        if(!result.ready||result.missingData.length)throw fail('COMPONENT_NOT_READY','组件账本尚未准备完成');
        ready.add(id);onProgress({id,phase:'ready'});return result;
      }catch(error){
        physical(paths.registryFile);atomicJson(paths.registryFile,JSON.parse(previous.toString('utf8')));
        const receipt=path.join(paths.profile,'agent-beta-activation-'+id+'.json');physical(receipt);fs.rmSync(receipt,{force:true});throw error;
      }
    }).catch(error=>{onProgress({id,phase:abort.aborted?'cancelled':'error',error:error.message,code:error.code});throw error;}).finally(()=>{pending.delete(id);controllers.delete(id);});
    queue=job.catch(()=>{});pending.set(id,job);return job;
  }
  return {ensure,pending,cancel(id){controllers.get(id)?.abort();},catalog,descriptor,ready};
}
