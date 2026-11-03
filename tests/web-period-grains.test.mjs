import test from 'node:test';
import assert from 'node:assert/strict';
import {periodGrainOptions} from '../ui/period-picker.mjs';

test('月度业务始终展示三个粒度，禁用日和年并给出原因',()=>{
 const options=periodGrainOptions(['month'],'本页按账期处理');
 assert.deepEqual(options.map(x=>[x.grain,x.label,x.disabled]),[['day','日',true],['month','月',false],['year','年',true]]);
 assert.equal(options[0].reason,'本页按账期处理');
 assert.equal(options[1].reason,'');
});
test('经营看板只开放后端支持粒度，非法配置不能开放其他粒度',()=>{
 assert.deepEqual(periodGrainOptions(['month','year']).map(x=>x.disabled),[true,false,false]);
 assert.deepEqual(periodGrainOptions(['day','month','year']).map(x=>x.disabled),[false,false,false]);
 assert.deepEqual(periodGrainOptions(['invalid']).map(x=>x.disabled),[true,false,true]);
});
