import {date,hash,fail,now} from './util.mjs';

const fixed=s=>{const [a,b='']=s.replace(',','.').split('.');return BigInt(a)*100000000n+BigInt(b.padEnd(8,'0').slice(0,8));};
export function parseCbr(xml,requested) {
  const effective=xml.match(/<ValCurs[^>]*Date="(\d{2})\.(\d{2})\.(\d{4})"/);if(!effective)throw fail('汇率来源格式发生变化');
  const effective_date=`${effective[3]}-${effective[2]}-${effective[1]}`;if(effective_date>requested)throw fail('汇率生效日晚于请求日');
  const currencies={RUB:100000000n};
  for(const block of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const code=block[1].match(/<CharCode>(\w+)<\/CharCode>/)?.[1],nominal=block[1].match(/<Nominal>(\d+)<\/Nominal>/)?.[1],value=block[1].match(/<Value>([\d,\.]+)<\/Value>/)?.[1];
    if(code&&nominal&&value)currencies[code]=fixed(value)/BigInt(nominal);
  }
  if(!currencies.CNY||currencies.CNY<=0n)throw fail('官方汇率缺少人民币数据');
  return ['RUB','USD','EUR'].filter(c=>currencies[c]).map(currency=>({date:requested,currency,rate:Number((currencies[currency]*100000000n+currencies.CNY/2n)/currencies.CNY),effective_date}));
}
export async function fetchRates(s,dates) {
  const unique=[...new Set(dates.map(date))];if(unique.length>366)throw fail('每次最多补充 366 个日期');
  const out=[];
  for(const d of unique) {
    if(s.get('SELECT 1 FROM month_locks WHERE month=?',d.slice(0,7))){out.push({date:d,status:'locked'});continue;}
    if(['RUB','USD','EUR'].every(c=>s.get('SELECT 1 FROM rates WHERE date=? AND currency=?',d,c))){out.push({date:d,status:'existing'});continue;}
    const source=`https://www.cbr.ru/scripts/XML_daily.asp?date_req=${d.slice(8,10)}/${d.slice(5,7)}/${d.slice(0,4)}`;
    try {const response=await fetch(source,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw fail('官方汇率服务暂不可用');const xml=new TextDecoder('windows-1251').decode(await response.arrayBuffer()),rates=parseCbr(xml,d);
      s.transaction(()=>{for(const r of rates)s.run('INSERT OR IGNORE INTO rates VALUES(?,?,?,?,?,?)',r.date,r.currency,r.rate,r.effective_date,source,hash(xml));s.audit('fx.fetch',d,{source,sha256:hash(xml),at:now()});});out.push({date:d,status:'ok'});
    }catch(e){out.push({date:d,status:'failed',message:e.message});}
  }
  return out;
}
