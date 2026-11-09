import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
