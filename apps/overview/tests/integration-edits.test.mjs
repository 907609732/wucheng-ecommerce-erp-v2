import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openStore} from '../lib/store.mjs';import {installOverviewEdits} from '../lib/integration-edits.mjs';
test('overview proposal preserves bill/payment rules and exact confirmed values',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'overview-reviewed-edit-')),s=openStore(dir);t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});
 const sources={shops:[]},api=installOverviewEdits({router:{get(){},post(){}},requireReview(){}},s,()=>sources);
 const bill=s.createBill({kind:'other',billNo:'B-1',party:'test',period:'2026-10',billDate:'2026-10-01',category:'software',amountCents:10000},sources);
 const draft=api.create({type:'bill',target:bill.id,patch:{amountCents:12345,note:'核对金额'},reason:'真实收据核对'});
 assert.equal(s.bill(bill.id).amountCents,10000);
 const result=await api.commit(draft.id,draft.revision,'ui');assert.equal(result.record.amountCents,12345);assert.equal(result.verified,true);
 s.addPayment(bill.id,{version:s.bill(bill.id).version,date:'2026-10-02',direction:'pay',amountCents:10000,reference:'P-1'});
 assert.throws(()=>api.create({type:'bill',target:bill.id,patch:{amountCents:9000},reason:'below-paid'}),/累计付款/);
 assert.equal(s.payments().length,1);
});
