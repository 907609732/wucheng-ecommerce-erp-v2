import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),reviewFile=path.join(root,'build/agent-beta-public-code-review.json');
const policy=JSON.parse(fs.readFileSync(reviewFile,'utf8'));
const {parse}=createRequire(path.join(root,'apps/exporter/package.json'))('@babel/parser');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const classificationPolicySha256=sha(Buffer.concat([fs.readFileSync(import.meta.filename),fs.readFileSync(reviewFile)]));
const cache=new Map();
function content(file){const stat=fs.statSync(file),old=cache.get(file);if(old&&old.size===stat.size&&old.modified===stat.mtimeMs)return old;const bytes=fs.readFileSync(file),value={size:stat.size,modified:stat.mtimeMs,bytes,text:bytes.toString('utf8'),sha256:sha(bytes)};cache.set(file,value);return value;}
function packageFile(file){const value=file.replaceAll('\\','/'),at=value.lastIndexOf('/node_modules/');if(at<0)return null;const rest=value.slice(at+14),parts=rest.split('/'),name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0],directory=value.slice(0,at+14)+name;try{const pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));return {directory,pkgName:pkg.name,version:pkg.version,relativeFile:rest.slice(name.length+1)};}catch{return null;}}
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...expected].sort().join('|');
function resourceManifest(value){
 if(!keys(value,['format','engines','modules','vendor','purchaseMobilePort','warehouseEntries','sourceDigests','approvalSha256','payloadHashes'])||value.format!=='agent-beta-resources/v1'||value.purchaseMobilePort!==27380||!hex(value.approvalSha256))return false;
 if(!keys(value.engines,['codex','hermes'])||Object.values(value.engines).some(e=>!keys(e,['entry','sha256'])||!hex(e.sha256)||typeof e.entry!=='string'))return false;
 if(!keys(value.modules,['warehouse','purchase','sales','overview','exporter']))return false;
 for(const [id,m]of Object.entries(value.modules)){if(!keys(m,id==='warehouse'?['root','version']:id==='exporter'?['root','version','entries','runtime']:['root','version','entries'])||m.root!=='apps/'+id||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version))return false;if(id!=='warehouse'&&(!Array.isArray(m.entries)||m.entries.some(p=>typeof p!=='string')))return false;if(id==='exporter'&&(!keys(m.runtime,['executable','sha256'])||!hex(m.runtime.sha256)))return false;}
 if(!keys(value.vendor,['catalogSha256','components'])||!hex(value.vendor.catalogSha256)||!Array.isArray(value.vendor.components)||value.vendor.components.length!==2||value.vendor.components.some(c=>!keys(c,['id','version','hostRange','archive','bytes','sha256'])||!hex(c.sha256)))return false;
 if(!keys(value.sourceDigests,['business','desktop','global'])||!keys(value.sourceDigests.business,['warehouse','purchase','sales','overview','exporter'])||![value.sourceDigests.desktop,value.sourceDigests.global,...Object.values(value.sourceDigests.business)].every(hex)||!Array.isArray(value.warehouseEntries)||value.warehouseEntries.some(p=>typeof p!=='string'))return false;
 return value.payloadHashes&&typeof value.payloadHashes==='object'&&!Array.isArray(value.payloadHashes)&&Object.entries(value.payloadHashes).every(([p,d])=>p&&!/[\\:\x00-\x1f]/.test(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..')&&hex(d));
}
function hashLine(text,finding,values){if(finding.StartLine!==finding.EndLine)return null;const line=(Array.isArray(text)?text:text.split(/\r?\n/))[finding.StartLine-1];if(!line)return null;try{const row=JSON.parse('{'+line.trim().replace(/,$/,'')+'}'),entries=Object.entries(row);if(entries.length!==1)return null;const [key,digest]=entries[0];return hex(digest)&&values[key]===digest?key:null;}catch{return null;}}
function changingKeyBoolean(text){const ast=parse(text,{sourceType:'module',attachComment:false}),nodes=[ast];while(nodes.length){const n=nodes.pop();if(n.type==='VariableDeclarator'&&n.id?.name==='changingKey'){const compact=text.slice(n.init.start,n.init.end).replace(/\s/g,'');return compact==='!!incoming.apiKey||incoming.clearApiKey===true';}for(const v of Object.values(n)){if(Array.isArray(v)){for(const e of v)if(e?.type)nodes.push(e);}else if(v?.type)nodes.push(v);}}return false;}

// Raw scanner reports remain unchanged. Only these finite reviewed byte/spans
// and the validated resource-digest map can be classified as false positives.
// Private-key and JWT material never receives an exception here.
export function classifySecretFinding({finding,file,stage,verifiedPayloadHashes}){
 if(!finding||['private-key','jwt'].includes(finding.RuleID))return null;
 const data=content(file);
 if(path.resolve(file)===path.join(path.resolve(stage),'agent-beta-resources.json')&&['generic-api-key','sentry-access-token','bitbucket-client-secret'].includes(finding.RuleID)){
  if(data.manifestValid===undefined){data.manifest=JSON.parse(data.text);data.manifestValid=resourceManifest(data.manifest);data.lines=data.text.split(/\r?\n/);}if(!data.manifestValid)return null;const key=hashLine(data.lines,finding,data.manifest.payloadHashes);return key&&verifiedPayloadHashes?.get(key)===data.manifest.payloadHashes[key]?{kind:'verified-public-payload-file-sha256',pointer:'/payloadHashes/'+key,fileSha256:data.sha256}:null;
 }
 const pkg=packageFile(file);
 for(const entry of policy.reviews){
  if(entry.rule!==finding.RuleID||entry.fileSha256!==data.sha256||!entry.spans.some(p=>p.startLine===finding.StartLine&&p.endLine===finding.EndLine&&p.startColumn===finding.StartColumn&&p.endColumn===finding.EndColumn))continue;
  if(entry.owner==='dependency'){if(!pkg||pkg.pkgName!==entry.pkgName||pkg.version!==entry.version||pkg.relativeFile!==entry.relativeFile)continue;}
  else{if(!file.replaceAll('\\','/').endsWith('/'+entry.relativeFile))continue;if(entry.relativeFile.endsWith('/settings.mjs')&&!changingKeyBoolean(data.text))continue;if(entry.relativeFile.endsWith('/hermes-compatibility.json')){const v=JSON.parse(data.text);if(!keys(v,['version','sourceCommit','files'])||!/^\d+\.\d+\.\d+$/.test(v.version)||!/^[a-f0-9]{40}$/.test(v.sourceCommit)||!Object.values(v.files||{}).every(hex)||!hashLine(data.text,finding,v.files))continue;}}
  return {kind:'pinned-reviewed-public-code',pkgName:entry.pkgName,version:entry.version,relativeFile:entry.relativeFile,fileSha256:data.sha256,semantic:entry.semantic};
 }
 return null;
}

const publicResources={
 exceljs:{version:'4.4.0',directory:'lib/doc/data',files:{'theme1.json':'ba4debed2079bf8c4021a062b51360e7710bf23931171f42b235dbcaa01245e7'}},
 undici:{version:'7.30.0',directory:'lib/web/cookies',files:{'constants.js':'85a24ae49eb5954e15363049bbc68967f01aae7260246daa3f49ad375429acb4','index.js':'3f3dd4ffc1e3db9f51a4e82c3c49e7d59c7921899eb897d9cf5b2787fdafe83d','parse.js':'d4768b29fd6b5ac9ad045936597618858dd15b38e1af6eb12281379fbfbbebe5','util.js':'51941b2fb0a6f29e389b91236050b1fc4bdaf57051ae53145767219a9d3c5f09'}}
};
export function classifyPublicRuntimePath(file,{isDirectory=false}={}){
 const pkg=packageFile(file);if(!pkg)return null;const spec=publicResources[pkg.pkgName];if(!spec||pkg.version!==spec.version)return null;
 if(isDirectory){if(pkg.relativeFile!==spec.directory||JSON.stringify(fs.readdirSync(file).sort())!==JSON.stringify(Object.keys(spec.files).sort())||Object.entries(spec.files).some(([name,d])=>!fs.lstatSync(path.join(file,name)).isFile()||fs.lstatSync(path.join(file,name)).isSymbolicLink()||content(path.join(file,name)).sha256!==d))return null;}
 else{const name=path.posix.basename(pkg.relativeFile);if(pkg.relativeFile!==spec.directory+'/'+name||spec.files[name]!==content(file).sha256)return null;}
 return {kind:'version-pinned-public-runtime-resource',pkgName:pkg.pkgName,version:pkg.version,relativeFile:pkg.relativeFile};
}
