// Structural acceptance is separate from executing the payload (smoke-native.mjs).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {verifyRelease} from '../../server/release.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function manifestFields(text){
 const fields=Object.create(null);
 for(const line of text.split(/\r?\n/)){
  if(!line.trim()||/^\s*[#;]/.test(line))continue;
  const m=/^\s*([a-zA-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if(!m||Object.hasOwn(fields,m[1]))throw Error('Invalid or duplicate manifest field');
  fields[m[1]]=m[2];
 }
 return fields;
}
export function verifyArtifact(folder){
 const root=fs.realpathSync(folder),app=path.join(root,'app');
 const read=p=>fs.readFileSync(path.join(root,p),'utf8');
 const requireFile=p=>{if(!fs.statSync(path.join(root,p)).isFile())throw Error('Missing payload '+p);};
 const manifest=read('manifest'),fields=manifestFields(manifest);
 for(const [key,value] of Object.entries({appname:'wuchengerp',version:'0.15.0',platform:'x86'}))if(fields[key]!==value)throw Error('Invalid manifest '+key);
 const staticConfig=path.join(app,'config');
 if(JSON.stringify(fs.readdirSync(staticConfig).sort())!==JSON.stringify(['privilege','resource']))throw Error('Only official static metadata may exist in app/config');
 for(const name of ['privilege','resource'])if(!fs.readFileSync(path.join(root,'config',name)).equals(fs.readFileSync(path.join(staticConfig,name))))throw Error('Official static metadata differs: '+name);
 const elf=['runtime/node/bin/node','runtime/chromium/chrome',...['Xvfb','x11vnc','xauth','xkbcomp'].map(n=>'runtime/sysroot/usr/bin/'+n)];
 for(const relative of elf){
  const f=path.join(app,relative),b=fs.readFileSync(f);
  if(b.length<64||!b.subarray(0,4).equals(Buffer.from([127,69,76,70]))||b[4]!==2||b[5]!==1||b.readUInt16LE(18)!==62)throw Error('Not Linux x86_64 ELF: '+relative);
  if(process.platform!=='win32'&&!(fs.statSync(f).mode&0o111))throw Error('ELF is not executable '+relative);
 }
 for(const p of ['runtime/node/LICENSE','runtime/novnc/LICENSE.txt','runtime/sysroot/usr/share/X11/xkb/rules/base','runtime/sysroot/usr/share/fonts/X11/misc/fonts.dir','runtime/sysroot/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','THIRD-PARTY.json','erp/server/fnos-native/lifecycle.mjs'])requireFile('app/'+p);
 for(const p of ['chromium/libvulkan.so.1','chromium/libvk_swiftshader.so','chromium/vk_swiftshader_icd.json','sysroot/usr/lib/x86_64-linux-gnu/gio/modules/libdconfsettings.so'])requireFile('app/runtime/'+p);
 for(const name of ['libnss_mymachines.so.2','libnss_mdns4_minimal.so.2','libva.so.2','libva-drm.so.2','libvulkan_intel.so','libvulkan_radeon.so']){
  if(!['usr/lib','lib'].some(dir=>{const f=path.join(app,'runtime/sysroot',dir,'x86_64-linux-gnu',name);return fs.existsSync(f)&&fs.statSync(f).isFile();}))throw Error('Missing dlopen payload '+name);
 }
 const chromiumDir=path.join(app,'runtime/chromium'),icdLibrary=JSON.parse(read('app/runtime/chromium/vk_swiftshader_icd.json')).ICD?.library_path;
 if(typeof icdLibrary!=='string'||path.resolve(chromiumDir,icdLibrary)!==path.join(chromiumDir,'libvk_swiftshader.so'))throw Error('SwiftShader ICD must point at the private Chromium library');
 for(const p of fs.readdirSync(path.join(root,'cmd'))){
  const f=path.join(root,'cmd',p);if(!fs.statSync(f).isFile())throw Error('Unexpected cmd entry');
  if(fs.readFileSync(f).includes(13))throw Error('CRLF hook '+p);
  if(process.platform!=='win32'&&!(fs.statSync(f).mode&0o111))throw Error('Hook is not executable '+p);
 }
 const html=read('app/runtime/novnc/vnc.html');
 const inline=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(m=>! /\bsrc\s*=/.test(m[1]));
 if(inline.length!==1||'sha256-'+createHash('sha256').update(inline[0][2]).digest('base64')!=='sha256-/9PPJp0RDtPobChVxkPiMU+aOqJaic/KxxORSdYVFHE=')throw Error('noVNC v1.6.0 bootstrap CSP differs');
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,e.name),relative=path.relative(root,file).split(path.sep).join('/');
  if(e.isSymbolicLink()){const resolved=fs.realpathSync(file);if(resolved!==root&&!resolved.startsWith(root+path.sep))throw Error('Escaping payload symlink '+relative);continue;}
  if(e.isDirectory()){if(/(?:^|\/)(?:browser-profiles|uvcs-home|\.plastic|\.ssh|\.aws|\.git)(?:\/|$)/.test(relative))throw Error('Private directory '+relative);walk(file);}
  else if(e.isFile()){
   if(/\.sqlite(?:[-.]|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:identity\.json|client\.conf|crypt\.key|Cookies|Login Data)$/.test(relative))throw Error('Private data '+relative);
   if(relative.startsWith('app/erp/')&&!relative.includes('/node_modules/')&&/^app\/erp\/(?:data|state|config|backups|logs)\//.test(relative))throw Error('Private ERP state '+relative);
   if(relative.startsWith('app/runtime/sysroot/')&&/^(?:ld-linux.*|lib(?:c|m|mvec|pthread|dl|rt|resolv|util|anl|BrokenLocale|nss_(?:files|dns|compat|hesiod))\.so(?:\..*)?)$/.test(e.name))throw Error('Private glibc is forbidden '+relative);
  }else throw Error('Special payload file '+relative);
 }}walk(root);
 const release=verifyRelease(path.join(app,'erp'));
 if(!release.acceptance?.ok||JSON.parse(read('app/erp/package.json')).version!=='0.15.0')throw Error('Release version or acceptance missing');
 return {ok:true,platform:'x86',version:'0.15.0',releaseFiles:release.files.length,manifestSHA256:sha(Buffer.from(manifest)),novncHTMLSHA256:sha(Buffer.from(html))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{console.log(JSON.stringify(verifyArtifact(process.argv[2])));}catch(e){console.error(e.message);process.exitCode=1;}}
