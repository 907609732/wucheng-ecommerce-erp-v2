import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {DatabaseSync} from 'node:sqlite';
import {createWarehouseDaily,businessDate} from '../core/erp/warehouse-daily.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-daily-ui-')),dataDir=path.join(root,'workspace','data');fs.mkdirSync(dataDir,{recursive:true});
const file=path.join(dataDir,'erp.sqlite'),db=new DatabaseSync(file),day=businessDate(),now=new Date().toISOString();
db.exec(`CREATE TABLE skus(sku TEXT PRIMARY KEY,name TEXT,barcode TEXT,low_stock_threshold INTEGER);
CREATE TABLE inventory_snapshots(sku TEXT,warehouse_id TEXT,snapshot_date TEXT,quantity REAL,imported_at TEXT);
CREATE TABLE inventory_data_validations(id INTEGER PRIMARY KEY,warehouse_id TEXT,source_date TEXT,status TEXT,row_count INTEGER,total_quantity REAL,created_at TEXT);
CREATE TABLE monthly_outbound(sku TEXT,month TEXT,total_outbound REAL,near_30_days_sales REAL);`);
const insert=db.prepare('INSERT INTO skus VALUES(?,?,?,10)'),stock=db.prepare('INSERT INTO inventory_snapshots VALUES(?,?,?,?,?)'),sales=db.prepare('INSERT INTO monthly_outbound VALUES(?,?,?,?)');
for(const [sku,name,quantity,count] of [['NORMAL','测试正常商品',100,30],['CRITICAL','测试严重预警商品',1,100],['URGENT','测试紧急补货商品',10,30],['WARNING','测试关注商品',20,30]]){insert.run(sku,name,'');stock.run(sku,'cainiao',day,quantity,now);sales.run(sku,day.slice(0,7),count,count);}
db.prepare('INSERT INTO inventory_data_validations VALUES(1,?,?,?,?,?,?)').run('cainiao',day,'valid',4,131,now);db.close();
const service=createWarehouseDaily({databasePath:file});service.configure({id:'local',role:'admin'},{employees:[{login:'demo@example.test',name:'演示员工（测试）',workdays:[1,2,3,4,5,6,7],channels:['email'],email:'demo@example.test',task:'核对库存预警并确认群消息'}],autoRemind:false});
const run=service.beginRun();service.updateRun(run,{sourceDate:day,collectedAt:now,validatedAt:now,importedAt:now,sentAt:now,collectionStatus:'success',validationStatus:'success',deliveryStatus:'accepted',validationId:1,fileHash:'test-only-synthetic-hash',rowCount:4,totalQuantity:131});service.close();
fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({runtimeMode:'server',firstRunPending:false,scheduleEnabled:false,monthlySalesEnabled:false,startAtLogin:false}));
const env={...process.env,LINGTU_ISOLATED_TEST:'1',LINGTU_MANAGED_MODULE:'1',LINGTU_REGISTRY_PATH:path.join(root,'registry.json')};delete env.ELECTRON_RUN_AS_NODE;
const packagedExecutable=process.env.WAREHOUSE_TEST_EXE?path.resolve(process.env.WAREHOUSE_TEST_EXE):'';
const app=await electron.launch({executablePath:packagedExecutable||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(packagedExecutable?[]:['.']),'--user-data-dir='+root,'--managed-module=warehouse'],env});
const errors=[];const out=path.resolve(process.env.WAREHOUSE_TEST_OUTPUT||path.join('.codex-artifacts','warehouse-daily'));fs.mkdirSync(out,{recursive:true});
try{
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
  await page.locator('#dailySyncBadge').filter({hasText:'今日已完成'}).waitFor();
  assert.equal(await page.locator('#dailyCheckIn').isDisabled(),true);assert.equal(await page.locator('#firstRunSetup,#runtimeSettingsForm').count(),0);
  await page.screenshot({path:path.join(out,'desktop-dashboard.png'),fullPage:true});
  await page.locator('[data-view="inventory"]').click();await page.locator('.gridjs-tbody tr').first().filter({hasText:'CRITICAL'}).waitFor();
  await page.screenshot({path:path.join(out,'desktop-inventory.png'),fullPage:true});
  await page.locator('[data-view="attendance"]').click();await page.locator('#dailyEmployeeRows').filter({hasText:'演示员工'}).waitFor();
  assert.equal(await page.locator('#dailyAutoRemind').isChecked(),false);
  await page.locator('#dailyEmployeeName').fill('新增测试员工');await page.locator('#dailyEmployeeLogin').fill('new@example.test');
  await page.locator('#dailyEmployeeSave').click();await page.locator('#dailyEmployeeRows').filter({hasText:'新增测试员工'}).waitFor();
  await page.screenshot({path:path.join(out,'desktop-attendance.png'),fullPage:true});
  await page.locator('[data-view="settings"]').click();assert.equal(await page.getByText('连接由工作台统一管理',{exact:true}).count(),1);
  assert.equal(await page.locator('#runtimeSettingsForm').count(),0);
  assert.equal(await page.locator('.hero-actions #featureManualButton').count(),0);
  assert.equal(await page.locator('[data-view-panel="settings"] #featureManualButton').isVisible(),true);
  await page.locator('#featureHelpTopic').selectOption('attendance');
  await page.locator('#featureManualButton').click();
  await page.locator('#featureHelpDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#featureHelpDialog').getAttribute('data-view'),'attendance');
  await page.locator('#featureHelpClose').click();
  await page.screenshot({path:path.join(out,'desktop-settings.png'),fullPage:true});
  assert.deepEqual(errors,[]);const receipt={ok:true,packaged:Boolean(packagedExecutable),executable:packagedExecutable,isolatedProfile:root,artifacts:out,rendererErrors:errors};fs.writeFileSync(path.join(out,'ui-verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await app.close();}
