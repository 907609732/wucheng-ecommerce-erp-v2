import { createHash, randomUUID } from 'node:crypto';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
export function fail(message, status=400, code='INVALID_INPUT') { return Object.assign(new Error(message), { status, code }); }
export function required(v, name, max=200) { if (typeof v!=='string' || !v.trim() || v.length>max) throw fail(`${name}不能为空，且不超过 ${max} 字`); return v.trim(); }
export function month(v) { if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(v)) throw fail('月份格式应为 YYYY-MM'); return v; }
export function date(v) {
  if(v instanceof Date) v=v.toISOString().slice(0,10);
  if(typeof v==='number') v=new Date(Date.UTC(1899,11,30)+v*86400000).toISOString().slice(0,10);
  const m=String(v??'').trim().match(/^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|\b)/);
  if(!m) throw fail('日期格式应为 YYYY-MM-DD');
  const s=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  const d=new Date(s+'T00:00:00Z'); if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s) throw fail('日期不存在'); return s;
}
export function bounds(m) { month(m); return [m+'-01',new Date(Date.UTC(+m.slice(0,4),+m.slice(5),0)).toISOString().slice(0,10)]; }
export function shiftMonth(m,n) { month(m); return new Date(Date.UTC(+m.slice(0,4),+m.slice(5)-1+n,1)).toISOString().slice(0,7); }
export function beijing(d=new Date()) { const s=new Date(+d+8*3600000).toISOString(); return { date:s.slice(0,10),month:s.slice(0,7),day:+s.slice(8,10),hour:+s.slice(11,13) }; }
export function monthsBetween(a,b) { month(a); month(b); const out=[]; for(let m=a;m<=b;m=shiftMonth(m,1)) { if(out.length>600) throw fail('范围过长'); out.push(m); } return out; }
export function money(v, optional=false) {
  if(v===null||v===undefined||String(v).trim()==='') { if(optional)return null; throw fail('缺少金额'); }
  const s=String(v).trim().replace(/[,，￥¥\s]/g,'');
  if(!/^-?\d+(\.\d{1,2})?$/.test(s))throw fail('金额必须为数字，最多两位小数');
  const [whole,dec='']=s.replace('-','').split('.'); const n=(BigInt(whole)*100n+BigInt(dec.padEnd(2,'0')))*(s.startsWith('-')?-1n:1n);
  if(n>100000000000000n||n< -100000000000000n)throw fail('金额超出范围'); return Number(n);
}
export function count(v) { if(v==null||v==='')return null; const n=Number(String(v).replaceAll(',','')); if(!Number.isSafeInteger(n)||n<0)throw fail('数量必须为非负整数'); return n; }
export function safeSum(values) { const n=values.reduce((a,b)=>a+BigInt(b??0),0n); if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw fail('金额汇总超出安全范围'); return Number(n); }
export function fxConvert(cents, rate) { if(cents==null||rate==null)return null; const n=BigInt(cents)*BigInt(rate); const out=(n+(n<0n?-50000000n:50000000n))/100000000n; const x=Number(out); if(!Number.isSafeInteger(x))throw fail('折算金额超出范围'); return x; }
export const serial = v => JSON.stringify(v);
