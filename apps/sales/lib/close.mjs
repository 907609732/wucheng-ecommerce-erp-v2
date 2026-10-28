import {now,id,month,required,fail,beijing} from './util.mjs';
import {revision,summarizeMonth} from './report.mjs';
import {makeBackup} from './backup.mjs';
import {aggregateFreight} from './freight.mjs';

export function closePreview(s,m){month(m);const r=revision(s,m);return {month:m,revision:r.revision,report:summarizeMonth(r.data),coverage:r.data.coverage,freight:aggregateFreight((r.data.freight||[]).filter(x=>x.status==='active')),locked:!!s.get('SELECT 1 FROM month_locks WHERE month=?',m)};}
export async function lockMonth(s,{month:m,revision:expected,confirmation},{skipBackup=false}={}) {
  month(m);if(confirmation!==`锁定 ${m}`)throw fail('请准确输入锁定确认文字');
  if(m>=beijing().month)throw fail('只能锁定已经结束的月份');
  if(!skipBackup)await makeBackup(s,'before-month-lock');
  return s.transaction(()=>{
    if(s.get('SELECT 1 FROM month_locks WHERE month=?',m))throw fail('月份已锁定',409);
    const r=revision(s,m);if(r.revision!==expected)throw fail('预览后数据已变化，请重新预览',409);
    const snapshot=JSON.stringify(r.data);s.run('INSERT INTO month_locks VALUES(?,?,?,?)',m,r.revision,snapshot,now());
    s.run('INSERT INTO month_history VALUES(?,?,?,?,?,?)',id(),m,'lock','用户确认锁定',snapshot,now());s.audit('month.lock',m,{revision:r.revision});return {ok:true};
  });
}
export async function unlockMonth(s,{month:m,reason,confirmation},{skipBackup=false}={}) {
  month(m);required(reason,'解锁原因',500);if(confirmation!==`解锁 ${m}`)throw fail('请准确输入解锁确认文字');
  if(!skipBackup)await makeBackup(s,'before-month-unlock');
  return s.transaction(()=>{const old=s.get('SELECT * FROM month_locks WHERE month=?',m);if(!old)throw fail('月份未锁定');
    s.run('INSERT INTO month_history VALUES(?,?,?,?,?,?)',id(),m,'unlock',reason,old.snapshot,now());s.run('DELETE FROM month_locks WHERE month=?',m);s.audit('month.unlock',m,{reason,prior_revision:old.revision});return {ok:true};});
}
