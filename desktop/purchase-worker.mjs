import { parentPort, workerData } from 'node:worker_threads';
import { PurchaseCollector } from './shared/purchase-collector.mjs';
let collector;
try { collector = new PurchaseCollector(workerData.databasePath, workerData.directory); const allowed = new Set(['preview', 'commit', 'cancel', 'read', 'readWorkbook', 'saveWorkbook', 'exportWorkbook', 'missingMonths', 'exportYearly', 'rollback', 'rollbackLast', 'operations', 'listHistory', 'readRevision', 'diffRevision', 'manualPreview']); if (!allowed.has(workerData.operation)) throw new Error('不支持的采购采集操作'); parentPort.postMessage({ ok: true, result: await collector[workerData.operation](...(workerData.args || [])) }); }
catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
finally { collector?.close(); }
