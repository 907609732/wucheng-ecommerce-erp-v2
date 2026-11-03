import {createHash,randomUUID} from 'node:crypto';
export const id=()=>randomUUID();
export const now=()=>new Date().toISOString();
export const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function required(v,label,max=200){v=String(v??'').trim();if(!v||v.length>max)throw fail(`${label}不能为空且不能超过 ${max} 字`);return v;}
export function date(v){v=String(v??'').slice(0,10);if(!/^20\d{2}-\d{2}-\d{2}$/.test(v)||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw fail('日期无效，请使用 YYYY-MM-DD');return v;}
export function month(v){v=String(v??'');if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(v))throw fail('月份无效');return v;}
export const lastMonth=()=>{const a=new Date();return new Date(Date.UTC(a.getUTCFullYear(),a.getUTCMonth()-1,1)).toISOString().slice(0,7);};
export function cents(v){const s=String(v??'').trim().replace(/[,￥¥\s]/g,'');if(!/^-?\d+(\.\d{1,2})?$/.test(s))throw fail('金额须为最多两位小数');const n=Math.round(Number(s)*100);if(!Number.isSafeInteger(n)||Math.abs(n)>1e12)throw fail('金额超出范围');return n;}
export function integer(v,label='金额'){if(!Number.isSafeInteger(v)||v<0||v>1e12)throw fail(`${label}须为非负整数分`);return v;}
export const sum=xs=>xs.reduce((a,b)=>{const v=a+b;if(!Number.isSafeInteger(v))throw fail('金额合计超出范围');return v;},0);
export const json=(s,fallback={})=>{try{return JSON.parse(s);}catch{return fallback;}};
export const CATEGORIES={inbound:'进货运输',outbound:'销售发货',returns:'退货运输',warehouse:'云仓服务',salary:'工资与奖金',labor:'劳务',software:'软件服务',rent:'房租',reimbursement:'报销',other:'其他费用'};
export const BUCKETS={income:'平台业务入账',refund:'交易退款',platformFee:'平台费用',purchase:'采购支出',freight:'额外运费实付',payroll:'人力实付',other:'其他实付',transfer:'资金往来',unknown:'待核对流水',receipt:'实际到账参考',excluded:'未计入',pendingRefund:'采购退款待归月'};
