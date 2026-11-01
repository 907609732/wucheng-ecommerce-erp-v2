import fs from 'node:fs';
import path from 'node:path';
import {crc32} from 'node:zlib';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {parse} from 'csv-parse/sync';
import {hash,fail,month} from './util.mjs';

export const MAX_BYTES=300*1024*1024;
export const DOWNLOAD_PATH=/^downloads\/cainiao\/[a-f0-9]{16}\/20\d{2}-(0[1-9]|1[0-2])\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(zip|xlsx|csv|xls|json)$/;
export const REPORTS={transactions:'交易明细',fees:'全部费用项',warehouse:'仓储明细'};
export function chinaMonth(time=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(time).replace(/\//g,'-');}
export function monthRange(from,to=from){
 month(from);month(to);if(from>to||to>chinaMonth())throw fail('请选择有效的历史月份或当前月');
 const result=[];let cur=from;while(cur<=to){result.push(cur);if(result.length>120)throw fail('一次最多下载 120 个月');const d=new Date(cur+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);cur=d.toISOString().slice(0,7);}return result;
}
export function monthDates(m){month(m);const [y,n]=m.split('-').map(Number);return {from:m+'-01',to:m+'-'+new Date(Date.UTC(y,n,0)).getUTCDate(),basis:'业务时间'};}
export function safeName(name){return path.win32.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,180)||'账单';}
export function resolveArchive(dir,rel){if(!DOWNLOAD_PATH.test(rel))throw fail('下载原件路径无效');const root=path.resolve(dir),target=path.resolve(root,rel);if(!target.startsWith(root+path.sep))throw fail('下载原件越界');return target;}
const cell=v=>v?.text??v?.result??(v?.richText?v.richText.map(t=>t.text).join(''):v??'');
const norm=v=>String(cell(v)).replace(/[\s（）()]/g,'');
async function checkedZip(buffer){
 // Inspect advertised expansion sizes before asking JSZip to inflate any member.
 const zip=await JSZip.loadAsync(buffer),entries=Object.values(zip.files).filter(f=>!f.dir);let bytes=0;
 if(entries.length>2000)throw fail('压缩包文件过多');
 for(const f of entries){bytes+=f._data.uncompressedSize;const raw=f.unsafeOriginalName||f.name;if(bytes>MAX_BYTES||/(^|[\\/])\.\.([\\/]|$)/.test(raw)||/^[\\/]|^[a-z]:/i.test(raw))throw fail('压缩包大小或路径无效');}
 return {zip,entries};
}
async function memberBytes(f){const b=await f.async('nodebuffer');if(b.length!==f._data.uncompressedSize||(crc32(b)>>>0)!==(f._data.crc32>>>0))throw fail('压缩包文件校验失败');return b;}
function tableSummary(name,rows){
 const index=rows.findIndex(r=>r.some(v=>/^(交易单号|费用项|物流履约单号|仓库名称|仓库资源名称)$/.test(norm(v))));
 if(index<0)return {name,recognized:false,rows:Math.max(0,rows.length-1)};
 const headers=rows[index].map(norm),data=rows.slice(index+1).filter(r=>r.some(v=>String(cell(v)).trim()!==''));
 const amountCol=headers.findIndex(h=>/^计费金额(合计)?(CNY)?$/.test(h));
 let amountCents=0,amountValid=amountCol>=0;
 for(const r of data){const v=String(cell(r[amountCol])).replace(/[,￥¥\s]/g,'');if(!/^-?\d+(\.\d+)?$/.test(v)){amountValid=false;continue;}amountCents+=Math.round(Number(v)*100);}
 const feeCol=headers.indexOf('费用项');
 const dateCol=headers.findIndex(h=>h==='业务时间'||h==='业务日期_分区字段'),periods=dateCol>=0?[...new Set(data.map(r=>String(cell(r[dateCol])).replace(/[-/]/g,'').slice(0,6)))]:[];
 return {name,recognized:true,rows:data.length,headers,periods,amountCents:amountValid?amountCents:null,fees:feeCol>=0?[...new Set(data.map(r=>String(cell(r[feeCol]))))]:[],role:headers.includes('仓库资源名称')&&headers.includes('业务日期_分区字段')?'warehouse':headers.includes('交易单号')&&headers.some(h=>h.startsWith('计费金额合计'))?'transactions':headers.includes('主单行数量')?'feeSummary':feeCol>=0?'feeDetails':headers.includes('货品ID')&&headers.includes('物流履约单号')?'goods':'other'};
}
export async function inspectBill(buffer,filename,budget={bytes:0,entries:0},depth=0){
 if(!buffer.length||buffer.length>MAX_BYTES)throw fail('下载文件为空或超过 300 MB');
 if(/^\s*(<!doctype|<html|\{"|登录)/i.test(buffer.subarray(0,200).toString()))throw fail('下载结果是错误页面，不是账单');
 const ext=path.extname(filename).toLowerCase();
 if(ext==='.zip'){
  if(depth>4)throw fail('压缩包嵌套层级过深');
  const {entries}=await checkedZip(buffer);let size=0;
  if(!entries.length||entries.length>2000)throw fail('压缩包为空或文件过多');
  for(const f of entries){size+=f._data.uncompressedSize;budget.bytes+=f._data.uncompressedSize;budget.entries++;if(size>MAX_BYTES||budget.bytes>MAX_BYTES||budget.entries>2000||/(^|[\\/])\.\.([\\/]|$)/.test(f.name)||/^[\\/]|^[a-z]:/i.test(f.name))throw fail('压缩包大小或路径无效');}
  const tables=[];for(const f of entries){if(!/\.(xlsx|csv|xls|zip)$/i.test(f.name)){tables.push({name:f.name,recognized:false});continue;}const x=await inspectBill(await memberBytes(f),f.name,budget,depth+1);tables.push(...x.tables);}
  return {format:'zip',tables,readable:tables.every(t=>t.recognized)};
 }
 if(ext==='.xlsx'){
  const {entries}=await checkedZip(buffer);for(const f of entries)await memberBytes(f);
  const w=new ExcelJS.Workbook();await w.xlsx.load(buffer);const tables=w.worksheets.map(s=>{const rows=[];s.eachRow({includeEmpty:true},r=>rows.push(r.values.slice(1)));return tableSummary(filename+' / '+s.name,rows);});
  if(!tables.length)throw fail('Excel 没有工作表');return {format:'xlsx',tables,readable:true};
 }
 if(ext==='.csv'){
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{text=new TextDecoder('gb18030').decode(buffer);}
  return {format:'csv',readable:true,tables:[tableSummary(filename,parse(text,{bom:true,skip_empty_lines:true,relax_column_count:true}))]};
 }
 if(ext==='.xls'&&buffer.subarray(0,8).toString('hex')==='d0cf11e0a1b11ae1')return {format:'xls',readable:false,tables:[],reason:'旧版 XLS 已保存，需人工核对'};
 throw fail('账单文件格式不受支持或内容不完整');
}
export function reconcile(report,inspection,expected){
 const tables=inspection.tables;let selected;
 if(report==='transactions')selected=tables.filter(t=>t.role==='transactions');
 if(report==='fees')selected=tables.filter(t=>t.role==='feeSummary');
 if(report==='warehouse'){const warehouse=tables.filter(t=>t.role==='warehouse'),verified=inspection.readable&&warehouse.length>0&&warehouse.every(t=>t.periods.every(m=>m===expected.period?.replace('-','')));return {verified,reason:verified?'仓储货品明细可读取，业务日期属于所选月份':'仓储文件已保存，格式或所属月份需要核对',tables};}
 if(!selected?.length)return {verified:false,reason:'文件已保存，尚未识别对应报表表头',tables};
 const rows=selected.reduce((n,t)=>n+t.rows,0),amount=selected.every(t=>t.amountCents!==null)?selected.reduce((n,t)=>n+t.amountCents,0):null;
 const reasons=[];if(rows!==expected.count)reasons.push(`行数 ${rows} 与页面 ${expected.count} 不一致`);if(amount===null||amount!==expected.amountCents)reasons.push(`计费金额与页面不一致`);
 if(report==='fees'&&expected.feeNames?.some(f=>!selected.some(t=>t.fees.includes(f))))reasons.push('费用项未全部覆盖');
 const details=tables.filter(t=>t.role==='feeDetails');if(!details.length)reasons.push('缺少计费明细');else if(details.some(t=>t.amountCents===null)||details.reduce((n,t)=>n+t.amountCents,0)!==expected.amountCents)reasons.push('计费明细金额与页面不一致');
 if(report==='transactions'&&!tables.some(t=>t.role==='goods'))reasons.push('缺少货品信息');
 if(expected.period&&details.some(t=>t.periods.some(p=>p!==expected.period.replace('-',''))))reasons.push('计费明细业务月份不一致');
 return {verified:!reasons.length,reason:reasons.join('；')||'行数及计费金额与页面一致',rows,amountCents:amount,tables};
}
export function archiveFile(s,job,item,source,filename,inspection,verification){
 const data=fs.readFileSync(source),digest=hash(data);const existing=s.get('SELECT * FROM cainiao_files WHERE account_key=? AND period=? AND report=? AND sha256=?',job.accountKey,item.month,item.type,digest);
 if(existing&&fs.existsSync(resolveArchive(s.dir,existing.path))&&hash(fs.readFileSync(resolveArchive(s.dir,existing.path)))===digest)return {id:existing.id,reused:true};
 const fid=crypto.randomUUID(),extension=path.extname(filename).toLowerCase(),rel=`downloads/cainiao/${job.accountKey}/${item.month}/${job.id}/${fid}${extension}`,target=resolveArchive(s.dir,rel);
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target+'.part',data,{flag:'wx'});fs.renameSync(target+'.part',target);
 s.run('INSERT INTO cainiao_files(id,job_id,account_key,period,report,path,filename,sha256,bytes,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',fid,job.id,job.accountKey,item.month,item.type,rel,safeName(filename),digest,data.length,JSON.stringify({inspection,verification,task:item.remoteTask,createdAt:new Date().toISOString()}));return {id:fid,reused:false};
}
