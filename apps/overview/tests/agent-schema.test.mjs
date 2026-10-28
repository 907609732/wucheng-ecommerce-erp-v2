import test from 'node:test';import assert from 'node:assert/strict';import Ajv from 'ajv';
import {overviewAgentCapabilities} from '../lib/agent-adapter.mjs';import {schemaFor} from '../lib/agent-schemas.mjs';import {bill} from './helpers.mjs';
const ajv=new Ajv({strict:false});
test('every declared overview capability has executable Chinese schema and mutation identity constraints',()=>{
 for(const cap of overviewAgentCapabilities){assert.match(cap.title,/[\u3400-\u9fff]/);assert.ok(cap.description.length>10);assert.equal(cap.inputSchema.additionalProperties,false);ajv.compile(cap.inputSchema);}
 const validate=ajv.compile(schemaFor('overview.bill-create'));assert.equal(validate(bill()),true);assert.equal(validate({...bill(),role:'admin'}),false);assert.equal(validate({...bill(),amountCents:0.5}),false);assert.equal(validate({...bill(),period:'2026-99'}),false);assert.equal(validate({...bill(),kind:'transfer-money'}),false);
 const update=ajv.compile(schemaFor('overview.bill-update'));assert.equal(update(bill()),false);assert.equal(update({...bill(),id:'real-id',version:1,reason:'核对'}),true);
 const upload=ajv.compile(schemaFor('overview.import'));assert.equal(upload({filename:'C:\\private\\bills.csv',dataBase64:'YQ==',sha256:'a'.repeat(64)}),false);assert.equal(upload({filename:'official.csv',dataBase64:'YQ==',sha256:'a'.repeat(64),options:{kind:'freight',mapping:{amount:5}}}),true);
 const read=ajv.compile(schemaFor('overview.bills'));assert.equal(read({limit:501}),false);assert.equal(read({limit:50,offset:100,kind:'freight'}),true);
});
