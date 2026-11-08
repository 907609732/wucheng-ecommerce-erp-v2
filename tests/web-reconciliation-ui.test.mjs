import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeCoverage,freightScopes,currentReconciliationMonth,cardAmounts} from '../apps/sales/public/reconciliation-ui.js';
test('empty and partial remain separate from locks',()=>{assert.equal(scopeCoverage({positiveFacts:0,missing:[]}), 'pending');assert.equal(scopeCoverage({positiveFacts:2,missing:['账单']}),'partial');});
test('freight shared warehouse occurs once and actual sf scopes are retained',()=>{const scopes=freightScopes([{id:'a'},{id:'b'}],[{channel:'sf',shop_id:'a'}]);assert.equal(scopes.filter(x=>x.channel==='warehouse').length,1);assert.equal(scopes.filter(x=>x.channel==='merchant').length,2);assert.deepEqual(scopes.filter(x=>x.channel==='sf').map(x=>x.shop_id),[null,'a']);});

test('valid zero and refund-only evidence does not become pending',()=>{assert.equal(scopeCoverage({positiveFacts:0,rows:{ledger:[{amount:-5}]},missing:['operations']}),'partial');assert.equal(scopeCoverage({positiveFacts:0,rows:{records:[{total:0}]},missing:[]}),'complete');assert.equal(scopeCoverage({positiveFacts:0,rows:{},missing:[],lock:{mode:'zero'}}),'complete');});

test('current month uses today rather than bootstrap default previous month',()=>{assert.equal(currentReconciliationMonth({month:'2026-10',today:'2026-11-08'}),'2026-11');assert.equal(currentReconciliationMonth({month:'2026-10'},new Date('2026-11-08T00:00:00Z')),'2026-11');});
test('cards have three amounts and preserve missing versus verified zero',()=>{assert.deepEqual(cardAmounts({hasData:false,totals:{income:0,expense:0,net:0}},'sales'),{income:null,expense:null,net:null});assert.deepEqual(cardAmounts({hasData:true,totals:{income:0,expense:-50,net:-50}},'sales'),{income:0,expense:-50,net:-50});assert.deepEqual(Object.keys(cardAmounts({hasData:true,totals:{total:10,shipping:8,extras:2,other:3}},'freight')),['total','shipping','extras']);assert.equal(scopeCoverage({hasData:false,positiveFacts:8,missing:[]}),'pending');});
