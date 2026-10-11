import { parentPort, workerData } from 'node:worker_threads';
import { FinanceLedger } from './shared/finance-ledger.mjs';
const store = new FinanceLedger(workerData.directory);
try {
  const methods = ['shops','shop','saveShop','createLoginShop','rollbackLoginShop','stage','inspect','preview','commit','restore','report','saveDraft','export','newJob','finishJob','recoverJobs','due','bill',
    'openJob','updateJob','jobDetail','jobItems','openBatch','addPart','closeBatch','retryPlan','batchDetail','previewBatch','commitBatch','activeVersion'];
  if (!methods.includes(workerData.operation)) throw new Error('未知财务操作');
  const result = await store[workerData.operation](...workerData.args);
  parentPort.postMessage({ ok: true, result });
} catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
finally { store.close(); }
