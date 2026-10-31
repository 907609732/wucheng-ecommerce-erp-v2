import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {packagedAgentResources,AGENT_RESOURCE_FORMAT_V1,AGENT_RESOURCE_FORMAT_V2} from '../desktop/agent-host/resource-layout.mjs';

const base=path.resolve('.codex-artifacts/agent-resource-layout-tests');
function fixture(t){
  fs.mkdirSync(base,{recursive:true});const work=fs.mkdtempSync(path.join(base,'case-')),resources=path.join(work,'resources');fs.mkdirSync(resources);
  t.after(()=>{const real=fs.realpathSync.native(work),relative=path.relative(base,real);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(real,{recursive:true,force:true});});
  const engines=root=>{const engine=path.join(root,'desktop','agent-runtime');fs.mkdirSync(engine,{recursive:true});for(const name of ['mcp-entry.mjs','hermes-bootstrap.py'])fs.writeFileSync(path.join(engine,name),'public entry');return engine;};
  return {work,resources,engines};
}

test('v2 uses the one physical packaged execution root',t=>{
  const {resources,engines}=fixture(t),root=path.join(resources,'agent-runtime'),launcher=path.join(root,'desktop','launcher');fs.mkdirSync(launcher,{recursive:true});const engine=engines(root);
  assert.deepEqual(packagedAgentResources({resourcesPath:resources,launcherDirectory:launcher}),{resourcesDir:root,engineResourceDir:engine,layout:AGENT_RESOURCE_FORMAT_V2});
});

test('legacy physical and ASAR-host launchers keep real external gateway entries',t=>{
  const {resources,engines}=fixture(t),engine=engines(path.join(resources,'workbench-gateway'));
  const physical=path.join(resources,'app','desktop','launcher');fs.mkdirSync(physical,{recursive:true});fs.writeFileSync(path.join(resources,'app.asar'),'legacy host archive');
  for(const launcherDirectory of [physical,path.join(resources,'app.asar','desktop','launcher')])assert.deepEqual(packagedAgentResources({resourcesPath:resources,launcherDirectory}),{resourcesDir:resources,engineResourceDir:engine,layout:AGENT_RESOURCE_FORMAT_V1});
});

test('unknown launch roots and missing external entries never fall back to another layout',t=>{
  const {work,resources,engines}=fixture(t);engines(path.join(resources,'workbench-gateway'));const launcher=path.join(resources,'agent-runtime','desktop','launcher');fs.mkdirSync(launcher,{recursive:true});
  assert.throws(()=>packagedAgentResources({resourcesPath:resources,launcherDirectory:launcher}));
  assert.throws(()=>packagedAgentResources({resourcesPath:resources,launcherDirectory:path.join(work,'source','desktop','launcher')}),/布局/);
  assert.throws(()=>packagedAgentResources({resourcesPath:'resources',launcherDirectory:launcher}),/完整路径/);
  assert.throws(()=>packagedAgentResources({resourcesPath:resources}),/完整路径/);
});

test('linked unified roots and linked engine entries are rejected',t=>{
  const {work,resources,engines}=fixture(t),outside=path.join(work,'outside'),launcher=path.join(resources,'agent-runtime','desktop','launcher');engines(outside);fs.mkdirSync(path.join(outside,'desktop','launcher'));fs.symlinkSync(outside,path.join(resources,'agent-runtime'),'junction');
  assert.throws(()=>packagedAgentResources({resourcesPath:resources,launcherDirectory:launcher}),/链接|重定向/);
  fs.unlinkSync(path.join(resources,'agent-runtime'));fs.mkdirSync(launcher,{recursive:true});const engine=engines(path.join(resources,'agent-runtime')),entry=path.join(engine,'mcp-entry.mjs');fs.unlinkSync(entry);fs.symlinkSync(path.join(outside,'desktop','agent-runtime','mcp-entry.mjs'),entry,'file');
  assert.throws(()=>packagedAgentResources({resourcesPath:resources,launcherDirectory:launcher}),/链接|重定向/);
});

test('an ASAR-looking resources root cannot be advertised to external processes',t=>{
  const {work,engines}=fixture(t),resources=path.join(work,'host.asar','resources'),root=path.join(resources,'agent-runtime'),launcher=path.join(root,'desktop','launcher');fs.mkdirSync(launcher,{recursive:true});engines(root);
  assert.throws(()=>packagedAgentResources({resourcesPath:resources,launcherDirectory:launcher}),/ASAR/);
});
