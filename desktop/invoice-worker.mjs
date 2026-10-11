import { parentPort, workerData } from 'node:worker_threads';
import { InvoiceInspectionStore } from './shared/invoice-inspection.mjs';
const store = new InvoiceInspectionStore(workerData.directory);
try {
  const methods = ['record', 'history', 'summary'];
  if (!methods.includes(workerData.operation)) throw new Error('未知开票巡检操作');
  const result = store[workerData.operation](...workerData.args);
  parentPort.postMessage({ ok: true, result });
} catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
finally { store.close(); }
