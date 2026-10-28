import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-preparation-ui-'));
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({main:'main.cjs'}));
fs.writeFileSync(path.join(root,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:480,height:260,webPreferences:{preload:${JSON.stringify(path.resolve('desktop/launcher/preparing-preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.resolve('desktop/launcher/preparing.html'))});});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[root,'--user-data-dir='+root],env});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.locator('#title').waitFor();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('launcher:preparation',{label:'正在准备工作台',detail:'正在准备采购台 · 1.6.2'}));
 await page.locator('#detail').filter({hasText:'采购台 · 1.6.2'}).waitFor();
 assert.equal(await page.locator('progress').getAttribute('value'),null,'No invented percentage');
 assert.equal(await page.evaluate(()=>!!window.launcher),false,'Preparation window exposes no business bridge');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,scope:'isolated static preparation window and real narrow preload',progressIpc:true,noBusinessApi:true,indeterminateProgress:true}));
}finally{await app.close();}
