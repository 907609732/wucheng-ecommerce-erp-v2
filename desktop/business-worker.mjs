import { parentPort, workerData } from 'node:worker_threads';

let store;
try {
  const { operation, args = [], databasePath, directory } = workerData;
  let result;
  if (operation === 'asset') {
    if (!/^[a-f0-9]{64}$/.test(String(args[0]))) throw new Error('图片编号无效');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 10000 });
    try {
      const asset = db.prepare('SELECT extension,content FROM business_assets WHERE id=?').get(args[0]);
      if (!asset) throw new Error('图片不存在');
      result = { id: args[0], extension: asset.extension, data: Buffer.from(asset.content) };
    } finally { db.close(); }
  }
  else if (operation === 'template' || operation === 'exportSnapshot') {
    const { exportBusinessWorkbook } = await import('./shared/business-workbook.mjs');
    result = operation === 'template' ? await exportBusinessWorkbook({}, [], { template: true }) : await exportBusinessWorkbook(args[0], args[1]);
  }
  else if (operation === 'exportSheetSnapshot') {
    const { exportSheetSnapshot } = await import('./shared/business-sheet.mjs');
    result = await exportSheetSnapshot(args[0], args[1]);
  }
  else {
    const { BusinessStore } = await import('./shared/business-store.mjs');
    store = new BusinessStore(databasePath, directory);
    const allowed = new Set(['read', 'preview', 'commit', 'cancel', 'versions', 'restore', 'asset', 'original', 'export', 'sheetSnapshot', 'saveCells', 'exportSheets', 'syncDingTalk']);
    if (!allowed.has(operation)) throw new Error('不支持的经营数据操作');
    result = operation === 'syncDingTalk' ? await store.syncDingTalk(message=>parentPort.postMessage({progress:message})) : await store[operation](...args);
  }
  parentPort.postMessage({ ok: true, result });
} catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
finally { store?.close(); }
