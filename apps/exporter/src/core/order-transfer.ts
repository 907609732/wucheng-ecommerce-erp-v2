import {createHash} from 'node:crypto';
import type {Task,Order} from '../shared/types';
function canonical(value:unknown):unknown{
  return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical((value as Record<string,unknown>)[k])])):value;
}
export function transferSnapshot(task:Task,orders:Order[]){
  if(!['taobao','alibaba','pdd','jd','xianyu'].includes(task.platform))throw Error('当前采购导入支持淘宝、1688、拼多多、京东和闲鱼');
  if(task.status==='running')throw Error('请先完成本次采集，再导入采购台');
  // Cookies and collector credentials are deliberately excluded.
  const sourceTask={id:task.id,platform:task.platform,account:task.account,accountKey:task.accountKey||'',from:task.from,to:task.to,status:task.status,listOutcome:task.listOutcome||'pending',count:task.count,updatedAt:task.updatedAt,plan:task.plan||null};
  const raw={task:sourceTask,orders:structuredClone(orders)};
  return {schema:'order-transfer/v1',...raw,digest:createHash('sha256').update(JSON.stringify(canonical(raw))).digest('hex')};
}
