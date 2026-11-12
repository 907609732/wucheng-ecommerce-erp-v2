import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export function verifySharedBrowserProcesses(rows,{profileRoot,launchRoot,instances}){
 // Linux /proc paths are POSIX even when these pure checks run on Windows.
 const within=(root,value)=>{if(typeof value!=='string'||!path.posix.isAbsolute(value))return false;const relative=path.posix.relative(root,value);return relative!==''&&relative!=='..'&&!relative.startsWith('../')&&!path.posix.isAbsolute(relative);};
 const argument=(p,name)=>{const args=p.cmdline||[],prefixed=args.find(a=>a.startsWith(name+'='));if(prefixed)return prefixed.slice(name.length+1);const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
 const ownedRuntime=p=>within(launchRoot,p.runtimeDirectory),sales=instances.sales,configured=Object.values(instances),configuredDisplays=new Set(configured.map(s=>':'+s.display)),configuredPorts=new Set(configured.map(s=>String(s.vncPort)));
 // Include every profile below the isolated root, including unexpected old
 // overview/retained profiles. The runtime witness also catches an owned
 // Chromium launched with a profile outside the intended root.
 const browserLeaders=rows.filter(p=>{const args=p.cmdline||[],name=path.posix.basename(args[0]||'');return !args.some(a=>a.startsWith('--type='))&&(within(profileRoot,argument(p,'--user-data-dir'))||ownedRuntime(p)&&/^(?:chrome|chromium|chromium-browser)$/.test(name));});
 const displays=rows.filter(p=>path.posix.basename(p.cmdline?.[0]||'')==='Xvfb'&&(ownedRuntime(p)||p.cmdline.some(a=>configuredDisplays.has(a))));
 const vncLeaders=rows.filter(p=>path.posix.basename(p.cmdline?.[0]||'')==='x11vnc'&&(ownedRuntime(p)||configuredDisplays.has(argument(p,'-display'))||configuredPorts.has(argument(p,'-rfbport'))));
 assert.equal(browserLeaders.length,1,'Expected one physical owned Chromium instance');assert.equal(displays.length,1,'Expected one physical owned Xvfb instance');assert.equal(vncLeaders.length,1,'Expected one physical owned x11vnc instance');
 const leader=browserLeaders[0];assert.equal(argument(leader,'--user-data-dir'),path.posix.join(profileRoot,'sales'),'Shared Chromium must use only the sales profile');assert.equal(argument(leader,'--remote-debugging-port'),String(sales.cdpPort),'Shared Chromium CDP port must match sales');
 assert(ownedRuntime(leader),'Chromium must carry the isolated native runtime witness');
 const generation=path.posix.relative(launchRoot,leader.runtimeDirectory);assert.match(generation,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,'Chromium runtime witness must be one private generation');
 for(const p of [...displays,...vncLeaders])assert.equal(p.runtimeDirectory,leader.runtimeDirectory,'Display/VNC must belong to the same owned generation');
 assert.equal(displays[0].cmdline[1],':'+sales.display,'Shared Xvfb must use only the sales display');assert.equal(argument(vncLeaders[0],'-display'),':'+sales.display,'Shared x11vnc must use only the sales display');assert.equal(argument(vncLeaders[0],'-rfbport'),String(sales.vncPort),'Shared x11vnc must use only the sales VNC port');
 return {chromium:browserLeaders.map(p=>p.pid),xvfb:displays.map(p=>p.pid),vnc:vncLeaders.map(p=>p.pid)};
}
export function diagnosticInitializationCleanup(services){
 // This source manager belongs to one disposable initializer, never to a later
 // lifecycle generation. Signal cleanup and its finally must await the same
 // authenticated stop, including its original rejection and child-exit wait.
 let stopping;
 return ()=>stopping??=Promise.resolve().then(()=>services.stopOwned());
}
export function diagnosticCancellation(file,onRequest){
 let requested=false,watcher;
 const inspect=()=>{if(file&&!requested&&fs.existsSync(file)){requested=true;onRequest();}};
 if(file){watcher=fs.watch(path.dirname(file),inspect);inspect();}
 return {check(){inspect();assert(!requested,'Diagnostic acceptance cancelled');},close(){watcher?.close();}};
}
export function isAllowedRuntimeLibrary(file,runtime,release){
 if(file.startsWith(runtime+'/')||file.startsWith(release+'/'))return true;
 if(/^\/(?:usr\/)?lib64\/ld-linux-x86-64\.so\.2$/.test(file))return true;
 return /^\/(?:usr\/)?lib\/x86_64-linux-gnu\/(?:ld-linux-x86-64\.so\.2|lib(?:c|m|mvec|pthread|dl|rt|resolv|util|anl|BrokenLocale|nss_(?:files|dns|compat|hesiod))\.so(?:\.[^/]+)*|gconv\/[^/]+\.so)$/.test(file);
}
export function mcpEvaluationResult(text){
 const match=text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
 if(!match)throw Error('MCP evaluation JSON result missing');
 return JSON.parse(match[1].trim());
}
export function verifySandboxResult(text){
 const body=mcpEvaluationResult(text);assert.equal(typeof body,'string','sandbox report must be text');
 const rows=new Map(body.split('\n').map(line=>line.split('\t').map(v=>v.trim())).filter(parts=>parts.length===2));
 const result={namespace:rows.get('Layer 1 Sandbox')==='Namespace'||rows.get('Namespace sandbox')==='Yes',pid:rows.get('PID namespaces')==='Yes',network:rows.get('Network namespaces')==='Yes',seccomp:rows.get('Seccomp-BPF sandbox')==='Yes'};
 assert(Object.values(result).every(Boolean),'Chromium namespace/PID/network/seccomp sandbox not active: '+JSON.stringify(result));return result;
}
