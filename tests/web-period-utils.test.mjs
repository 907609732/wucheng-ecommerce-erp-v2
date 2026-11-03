import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPeriod,parsePeriod,shiftPeriod} from '../ui/period-picker.mjs';

test('真实日历校验区分闰年、世纪年和不存在的日期',()=>{
  for(const day of ['2000-02-29','2024-02-29','2026-04-30'])assert.equal(parsePeriod('day',day),day);
  for(const day of ['1900-02-29','2025-02-29','2026-04-31','2026-00-01','2026-01-00','2026-13-01','2026-1-01','2026-01-01x'])assert.equal(parsePeriod('day',day),null,day);
  for(const value of [null,undefined,2026,{},'2026-13','2026-00'])assert.equal(parsePeriod('month',value),null);
});
test('步进遵循日历，正确跨闰日、月末和年末',()=>{
  for(const [grain,period,delta,expected]of [['day','2024-02-28',1,'2024-02-29'],['day','2024-02-29',1,'2024-03-01'],['day','2025-03-01',-1,'2025-02-28'],['day','2026-12-31',1,'2027-01-01'],['month','2026-12',1,'2027-01'],['month','2026-01',-1,'2025-12'],['year','2026',-1,'2025']])assert.equal(shiftPeriod(grain,period,delta),expected);
});
test('各粒度边界拒绝越界，月度上限包含该月最后一天',()=>{
  for(const [grain,period,delta]of [['day','2000-01-01',-1],['day','2099-12-31',1],['month','2000-01',-1],['month','2099-12',1],['year','2000',-1],['year','2099',1]])assert.equal(shiftPeriod(grain,period,delta),null);
  const range={min:'2024-02',max:'2024-02'};
  assert.equal(shiftPeriod('day','2024-02-28',1,range),'2024-02-29');
  assert.equal(shiftPeriod('day','2024-02-29',1,range),null);
  assert.equal(shiftPeriod('day','2024-02-01',-1,range),null);
  assert.deepEqual(range,{min:'2024-02',max:'2024-02'});
  assert.equal(shiftPeriod('month','2026-13',1),null);
  assert.equal(shiftPeriod('month','2026-01',0.5),null);
});
test('中文显示不补零，清除值保持全部月份语义',()=>{
  assert.equal(formatPeriod('year','2026'),'2026年');
  assert.equal(formatPeriod('month','2026-01'),'2026年1月');
  assert.equal(formatPeriod('day','2026-01-03'),'2026年1月3日');
  assert.equal(formatPeriod('month',null),'全部月份');
  assert.equal(formatPeriod('day','2026-02-30'),'');
});
