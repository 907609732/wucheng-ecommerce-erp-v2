import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../lib/db.mjs';
import {addLedger,setCoverage} from '../lib/ledger.mjs';
import {report} from '../lib/report.mjs';
import {freightReport,saveFreight} from '../lib/freight.mjs';
import {decorateSalesQuery,decorateSalesPreparation,salesResultEditFields,salesCapabilityPresentation} from '../lib/agent-presentation.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-agent-presentation-')),store=openStore(dir);t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sales-agent-presentation-'));fs.rmSync(dir,{recursive:true,force:true});});return store;}
const charts=value=>value.blocks.filter(block=>block.type==='chart');
function sourcesExist(value){const ids=new Set(value.evidence.map(source=>source.id));for(const chart of charts(value)){assert.ok(chart.sourceRefs.length>0);assert.ok(chart.sourceRefs.every(id=>ids.has(id)));assert.ok(chart.rows.every(row=>typeof row.key==='string'));assert.ok(!Object.hasOwn(chart,'editableFields'));}}

test('real report trends preserve missing months, source evidence and read-only statistics',t=>{
 const store=fixture(t);addLedger(store,{shop_id:'offline',date:'2026-03-02',kind:'sale',amount:'100.25',currency:'CNY',external_id:'presentation-sale'});setCoverage(store,{shop_id:'offline',month:'2026-03',dataset:'operations',status:'full',evidence:'实际完整月手工登记'});
 const input={period:'2026-03',shop:'offline'},raw=report(store,input),before=JSON.stringify(raw),result=decorateSalesQuery('sales.report',input,raw),chart=charts(result)[0];
 assert.equal(JSON.stringify(raw),before);assert.deepEqual(result.operations,raw.operations);assert.deepEqual(result.reconciliation,raw.reconciliation);assert.deepEqual(result.trend,raw.trend);
 assert.equal(chart.chartType,'line');assert.equal(chart.rows.find(row=>row.label==='2026-03').sales,10025);assert.equal(chart.rows.find(row=>row.label==='2026-02').sales,null);assert.equal(chart.completeness.state,'partial');assert.ok(chart.series.every(series=>series.unit==='分'&&series.currency==='CNY'));assert.doesNotMatch(chart.title,/利润/);sourcesExist(result);
 assert.ok(result.blocks.some(block=>block.id==='sales.report.operations'));assert.ok(result.blocks.some(block=>block.id==='sales.report.reconciliation'));assert.ok(result.blocks.every(block=>!Object.hasOwn(block,'editableFields')));
 const repeated=decorateSalesQuery('sales.report',input,result);assert.equal(charts(repeated).length,1);assert.equal(repeated.evidence.length,result.evidence.length);assert.deepEqual(charts(repeated)[0].sourceRefs,chart.sourceRefs);
});

test('missing actual FX is not guessed into a chart amount',t=>{
 const store=fixture(t);addLedger(store,{shop_id:'offline',date:'2026-03-02',kind:'sale',amount:'42.50',currency:'RUB',external_id:'presentation-rub'});setCoverage(store,{shop_id:'offline',month:'2026-03',dataset:'operations',status:'full',evidence:'原币登记已核，参考汇率尚未取得'});
 const input={period:'2026-03',shop:'offline'},raw=report(store,input),result=decorateSalesQuery('sales.report',input,raw);assert.equal(raw.totals.sales,null);assert.equal(charts(result)[0].rows.find(row=>row.label==='2026-03').sales,null);assert.equal(charts(result)[0].completeness.state,'partial');sourcesExist(result);
});

test('real freight charts retain negative compensation, null gaps and partial completeness',t=>{
 const store=fixture(t);saveFreight(store,{request_id:'presentation-freight',channel:'warehouse',entry_mode:'month',period:'2026-03',shipping:'1051.20',materials:'25.01',other:'-232.32',other_note:'真实赔付抵扣'},[]);
 const input={period:'2026-03'},raw=freightReport(store,input),before=JSON.stringify(raw),result=decorateSalesQuery('sales.freight-report',input,raw),trend=charts(result).find(chart=>chart.chartType==='line'),fees=charts(result).find(chart=>chart.chartType==='bar');
 assert.equal(JSON.stringify(raw),before);assert.deepEqual(result.by_shop,raw.by_shop);assert.deepEqual(result.channels,raw.channels);assert.equal(trend.rows.find(row=>row.label==='2026-03').total,84389);assert.equal(trend.rows.find(row=>row.label==='2026-03').other,-23232);assert.equal(trend.rows.find(row=>row.label==='2026-02').total,null);assert.equal(fees.rows.find(row=>row.key==='other').amount,-23232);assert.ok(charts(result).every(chart=>chart.completeness.state==='partial'));sourcesExist(result);
});

test('only explicit draft cells are editable in input units with stable operation keys',()=>{
 const input={shop_id:'offline',date:'2026-03-02',kind:'sale',amount:'12.55',currency:'CNY',external_id:'001234',note:'核对后录入'},preview=id=>({summary:'真实预演',blocks:[{type:'table',title:'业务预演结果',rows:[{id,amount:1255}]}],changes:[{operation:'ledger-create',input}],commitData:{operation:'ledger-create',input}}),raw=preview('temporary-preview-one'),result=decorateSalesPreparation('sales.ledger-create',input,raw),draft=result.blocks.find(block=>block.id==='sales.ledger-create.draft');
 assert.equal(draft.rowKey,'key');assert.equal(draft.rows[0].amount,'12.55');assert.equal(result.blocks[0].rows[0].amount,1255);assert.equal(raw.blocks.length,1);assert.ok(!Object.hasOwn(result.blocks[0],'editableFields'));assert.ok(draft.editableFields.every(field=>salesResultEditFields('sales.ledger-create').includes(field)));assert.ok(!draft.editableFields.includes('key'));assert.equal(draft.rows[0].key,decorateSalesPreparation('sales.ledger-create',input,preview('temporary-preview-two')).blocks.at(-1).rows[0].key);
 assert.deepEqual(result.changes,raw.changes);assert.deepEqual(result.commitData,raw.commitData);assert.equal(decorateSalesPreparation('sales.ledger-create',input,result).blocks.length,result.blocks.length);
 for(const id of ['sales.report','sales.freight-report','sales.ledger','sales.match-create','sales.month-lock','sales.cainiao-posting']){assert.deepEqual(salesResultEditFields(id),[]);assert.deepEqual(salesCapabilityPresentation(id),{});assert.equal(decorateSalesPreparation(id,input,raw),raw);}
 for(const id of ['sales.ledger-update','sales.freight-create','sales.freight-update']){const fields=salesResultEditFields(id);assert.ok(fields.length>0);assert.ok(!fields.some(field=>['id','version','files','remove_attachments','approval','confirmed','role','commitData'].includes(field)));assert.deepEqual(salesCapabilityPresentation(id),{resultEditFields:fields});fields.push('injected');assert.ok(!salesResultEditFields(id).includes('injected'));}
});
