import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readTable,normalizeTable} from '../lib/importer.mjs';
import {openStore,summarize} from '../lib/store.mjs';
const file=process.argv[2];if(!file)throw Error('请提供采购表路径');
const buffer=fs.readFileSync(file),filename=path.basename(file),table=await readTable(buffer,filename),parsed=normalizeTable(table);
if(parsed.issues.length||parsed.orders.some(o=>o.errors.length))throw Error('源文件存在待核对问题，需使用导入预览');
const store=openStore(path.resolve('data'));try{
 const hash=createHash('sha256').update(buffer).digest('hex');
 if(store.db.prepare('SELECT id FROM imports WHERE hash=?').get(hash)){console.log('原始文件已入库，无需再次导入。');}
 else{const filePath=`originals/${randomUUID()}.xlsx`;fs.writeFileSync(path.join(store.dir,filePath),buffer);const result=store.importBatch(parsed.orders.map(o=>({order:o,original:{headers:table.headers,rows:o.raw,normalized:o}})),{filename,hash,filePath,lineCount:parsed.lineCount,metadata:{method:'initial-import',sheet:table.sheet}});console.log(JSON.stringify(result));}
 const s=summarize(store.list(),'2026');console.log(JSON.stringify({orders:store.list().length,items:store.list().reduce((s,o)=>s+o.items.length,0),effectiveOrders:s.orderCount,amountCents:s.amountCents,excludedCount:s.excludedCount,excludedCents:s.excludedCents,months:s.months}));
}finally{store.close();}
