import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BusinessStore} from '../desktop/shared/business-store.mjs';
import {numeric, scalar, recordMonth, projectDingTalk, collectDingTalk} from '../desktop/shared/business-dingtalk.mjs';
import {parseBusinessWorkbook} from '../desktop/shared/business-workbook.mjs';

test('钉钉识别文本、百分比、公式零值与未填报严格区分',()=>{
  assert.equal(numeric('￥1,234.50元'),1234.5);
  assert.equal(numeric('4.25%'),.0425);
  assert.equal(numeric({value:['0']}),0);
  assert.equal(numeric({value:[]}),null);
  assert.equal(numeric('未填报'),null);
  assert.equal(scalar({value:['#REF!']}),'#REF!');
  assert.equal(recordMonth({cells:{d:'2026年02月'}},[{fieldId:'d',fieldName:'日期',type:'text'}]),'2026-02');
});

test('钉钉快照多凭证导出重导入、版本恢复及来源编辑保护',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'business-dingtalk-'));
  const store=new BusinessStore(path.join(directory,'data.sqlite'),directory);
  try {
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=','base64');
    const id=createHash('sha256').update(bytes).digest('hex'),assets=[{id,extension:'png',data:bytes}];
    const table={tableId:'shop',name:'店口五金店-淘宝',scope:'sales',fields:[{fieldId:'date',fieldName:'日期',type:'date'},{fieldId:'proof',fieldName:'图片和附件',type:'attachment'},{fieldId:'paid',fieldName:'支付金额',type:'text'},{fieldId:'net',fieldName:'净支付金额',type:'formula',config:{formula:'[支付金额]'}}],records:[{recordId:'row1',cells:{date:'2026-01-01',paid:'100.00',net:{value:['88.12']},proof:[{resourceId:'img1',assetId:id},{resourceId:'img2',assetId:id}]}},{recordId:'row2',cells:{date:'2026-02-01',net:{value:['0']}}}]};
    const images=[0,1].map(position=>({id:'proof'+position,assetId:id,sheet:table.name,cell:'B2',month:'2026-01',shop:table.name,label:'图片和附件',recordId:'row1',fieldId:'proof',position}));
    const data=projectDingTalk([table],2026,images);data.hash='first';
    const first=await store.commitDingTalk(data,assets,[]);
    assert.equal(store.read().summary.net,88.12);
    assert.equal(store.read().monthly[1].paid,null);
    assert.equal((await store.commitDingTalk(data,assets,[])).unchanged,true);
    assert.equal(store.versions().length,1);
    const snapshot=await store.sheetSnapshot(2026);
    assert.equal(snapshot.cloud,true);assert.equal(snapshot.sheets[0].images.length,2);
    await assert.rejects(store.saveCells({year:2026,versionId:first.versionId,changes:[{sheet:table.name,cell:'C2',input:'200'}]}),/请在钉钉修改/);
    const exported=await store.export({year:2026,month:'2026-01'}),parsed=parseBusinessWorkbook(exported);
    assert.equal(parsed.data.images.length,2);assert.equal(parsed.assets.length,1);
    assert.equal(parsed.data.monthly.length,1);assert.equal(parsed.data.monthly[0].net,88.12);
    assert.equal(parsed.data.dingtalkTables[0].fields[3].config.formula,'[支付金额]');
    const next=structuredClone(data);next.hash='second';next.monthly[0].net=99;
    await store.commitDingTalk(next,assets,[]);assert.equal(store.read().summary.net,99);
    store.restore(first.versionId);assert.equal(store.read().summary.net,88.12);
    assert.equal(store.versions().length,2);
    const call=async args=>args[0]==='drive'?{result:{extension:'able'}}:args[1]==='+list-tables'?{tables:[{tableId:'shop',tableName:table.name}]}:args[1]==='+field-get'?{data:{fields:table.fields}}:{data:{records:[],nextCursor:'unfinished'}};
    await assert.rejects(collectDingTalk(store,()=>{},{call}),/分页未完成/);
    assert.equal(store.read().versionId,first.versionId);
    await assert.rejects(collectDingTalk(store,()=>{},{call:async()=>{throw new Error('认证失败');}}),/认证失败/);
    assert.equal(store.read().versionId,first.versionId);
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});
