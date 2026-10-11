import fs from 'node:fs';
import path from 'node:path';
import { FinanceLedger } from '../desktop/shared/finance-ledger.mjs';
import { receiveLocalBills } from '../desktop/shared/finance-local-receipt.mjs';

// 显式传入应用的财务目录；不猜测用户数据库位置或自动建立店铺。
const [directory, manifestPath] = process.argv.slice(2);
if (!directory || !manifestPath) {
  console.error('用法：node scripts/finance-receive-local.mjs <已有财务数据目录> <本地清单.json>');
  process.exitCode = 1;
} else {
  let store;
  try {
    if (!fs.existsSync(path.join(directory, 'finance.sqlite'))) throw new Error('财务数据库不存在，请先在软件中设置店铺并确认数据目录');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    store = new FinanceLedger(directory);
    console.log(JSON.stringify(receiveLocalBills(store, manifest, path.dirname(path.resolve(manifestPath))), null, 2));
  } catch (error) {
    console.error(`账单接收失败：${error.message}`);
    process.exitCode = 1;
  } finally { store?.close(); }
}
