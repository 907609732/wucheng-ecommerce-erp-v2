import assert from 'node:assert/strict';
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
