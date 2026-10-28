import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {_electron} from 'playwright';

// Actual isolated Electron process; no account or provider credentials supplied.
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-agent-electron-'));
try{for(const managed of [false,true]){
  const profile=path.join(directory,managed?'agent':'legacy'),workspace=path.join(profile,'workspace'),data=path.join(workspace,'data');fs.mkdirSync(data,{recursive:true});fs.copyFileSync('config.json',path.join(workspace,'config.json'));
  const initialized=spawnSync(process.execPath,['--input-type=module','-e',"import {getDb,closeDb} from './core/erp/db.js';getDb();closeDb();"],{env:{...process.env,CAINIAO_APP_DATA_DIR:workspace,ERP_DATA_DIR:data},windowsHide:true,encoding:'utf8'});assert.equal(initialized.status,0,initialized.stderr);
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({runtimeMode:'server',firstRunPending:false,scheduleEnabled:true,scheduleTime:'22:00',monthlySalesEnabled:true,monthlySalesTime:'22:00',startAtLogin:false}));
  const env={...process.env,LINGTU_ISOLATED_TEST:'1',LINGTU_MANAGED_MODULE:'1',LINGTU_REGISTRY_PATH:path.join(profile,'registry.json'),LINGTU_AGENT_MANAGED:managed?'1':'0'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:['.','--user-data-dir='+profile,'--managed-module=warehouse'],env});
  try{const page=await app.firstWindow();await page.waitForFunction(()=>!!window.inventoryApp);const state=await page.evaluate(()=>window.inventoryApp.getState());assert.equal(state.schedulingOwner,managed?'agent':'legacy');assert.equal(state.legacyAutomaticRemindersEnabled,!managed);assert.equal(Boolean(state.nextScheduledRun),!managed);assert.equal(Boolean(state.nextMonthlyScheduledRun),!managed);assert.equal(state.running,false);if(managed)await assert.rejects(page.evaluate(()=>window.inventoryApp.runNow()),/中央任务结果页/);assert.deepEqual(state.queuedTasks,[]);const settings=JSON.parse(fs.readFileSync(path.join(profile,'settings.json')));assert.equal(settings.scheduleEnabled,true);assert.equal(settings.scheduleTime,'22:00');console.log(JSON.stringify({ok:true,mode:state.schedulingOwner,legacyTimerActive:!!state.nextScheduledRun,settingsPreserved:true}));}finally{await app.close();}
}}finally{fs.rmSync(directory,{force:true,recursive:true});}
