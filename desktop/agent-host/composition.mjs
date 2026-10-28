import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

function installedExecutable(name){
  try{return execFileSync('where.exe',[name],{encoding:'utf8',timeout:5000,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/).find(file=>path.isAbsolute(file)&&fs.existsSync(file));}catch{return undefined;}
}
export async function composeAgentDependencies({transport,nodeExecutable=process.execPath}={}){
  const [runtime,codex,hermes,warehouse,purchase,sales,overview,exporter,backups]=await Promise.all([
    import('../agent-runtime/index.mjs'),import('../agent-runtime/codex-engine.mjs'),import('../agent-runtime/hermes-engine.mjs'),
    import('../workbench/warehouse-agent.mjs'),import('../../apps/purchase/lib/agent-adapter.mjs'),import('../../apps/sales/lib/agent-adapter.mjs'),
    import('../../apps/overview/lib/agent-adapter.mjs'),import('../../apps/exporter/src/main/agent-adapter.mjs'),import('./backups.mjs')
  ]);
  const codexExe=installedExecutable('codex.exe'),npmScript=path.join(process.env.APPDATA||'','npm','node_modules','@openai','codex','bin','codex.js');
  const hermesRoot=path.join(process.env.LOCALAPPDATA||'','hermes','hermes-agent'),python=path.join(hermesRoot,'venv','Scripts','python.exe');
  return {runtimeFactory:runtime.createAgentRuntime,createBackups:backups.createAgentBackups,adapters:[warehouse.createWarehouseAgentAdapter({transport}),purchase.createPurchaseAgentAdapter({transport}),sales.createSalesAgentAdapter({transport}),overview.createOverviewAgentAdapter({transport}),exporter.createExporterAgentAdapter({transport})],engines:{
    codex:codex.createCodexEngine({command:codexExe||(fs.existsSync(npmScript)?nodeExecutable:undefined),argsPrefix:codexExe?[]:fs.existsSync(npmScript)?[npmScript]:[],nodeExecutable}),
    hermes:hermes.createHermesEngine({python:fs.existsSync(python)?python:undefined,root:hermesRoot,nodeExecutable})
  }};
}
