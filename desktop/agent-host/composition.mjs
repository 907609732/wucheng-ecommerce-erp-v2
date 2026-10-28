import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

function installedExecutables(name){
  try{return execFileSync('where.exe',[name],{encoding:'utf8',timeout:5000,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/).filter(file=>path.isAbsolute(file)&&fs.existsSync(file));}catch{return [];}
}
export async function selectCompatibleCodex({createEngine,nodeExecutable,appData=process.env.APPDATA,locate=installedExecutables,engineOptions={}}){
  const npmScript=appData&&path.join(appData,'npm','node_modules','@openai','codex','bin','codex.js');
  const candidates=[...(npmScript&&fs.existsSync(npmScript)?[{command:nodeExecutable,argsPrefix:[npmScript],source:'npm'}]:[]),...locate('codex.exe').map(command=>({command,argsPrefix:[],source:'executable'}))],checks=[];
  for(const candidate of candidates){const engine=createEngine({...candidate,nodeExecutable,...engineOptions});let status;try{status=await engine.check();}catch{status={available:false,code:'CODEX_CHECK_FAILED'};}checks.push({source:candidate.source,...status});if(status.available)return engine;}
  const unavailable=createEngine({nodeExecutable,...engineOptions}),check=unavailable.check;unavailable.check=async()=>({...await check(),candidates:checks});return unavailable;
}
export async function composeAgentDependencies({transport,nodeExecutable=process.execPath,engineResourceDir}={}){
  const [runtime,codex,hermes,warehouse,purchase,sales,overview,exporter,backups]=await Promise.all([
    import('../agent-runtime/index.mjs'),import('../agent-runtime/codex-engine.mjs'),import('../agent-runtime/hermes-engine.mjs'),
    import('../workbench/warehouse-agent.mjs'),import('../../apps/purchase/lib/agent-adapter.mjs'),import('../../apps/sales/lib/agent-adapter.mjs'),
    import('../../apps/overview/lib/agent-adapter.mjs'),import('../../apps/exporter/src/main/agent-adapter.mjs'),import('./backups.mjs')
  ]);
  const engineOptions=engineResourceDir?{mcpEntryPath:path.join(engineResourceDir,'mcp-entry.mjs')}:{},codexEngine=await selectCompatibleCodex({createEngine:codex.createCodexEngine,nodeExecutable,engineOptions});
  const hermesRoot=path.join(process.env.LOCALAPPDATA||'','hermes','hermes-agent'),python=path.join(hermesRoot,'venv','Scripts','python.exe');
  return {runtimeFactory:runtime.createAgentRuntime,createBackups:backups.createAgentBackups,adapters:[warehouse.createWarehouseAgentAdapter({transport}),purchase.createPurchaseAgentAdapter({transport}),sales.createSalesAgentAdapter({transport}),overview.createOverviewAgentAdapter({transport}),exporter.createExporterAgentAdapter({transport})],engines:{
    codex:codexEngine,
    hermes:hermes.createHermesEngine({python:fs.existsSync(python)?python:undefined,root:hermesRoot,nodeExecutable,...engineOptions,...(engineResourceDir?{bootstrapPath:path.join(engineResourceDir,'hermes-bootstrap.py')}: {})})
  }};
}
