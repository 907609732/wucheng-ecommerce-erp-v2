import { Worker } from 'node:worker_threads';
const queues = new Map();
export function invoiceJob(directory, operation, ...args) {
  const previous = queues.get(directory) || Promise.resolve();
  const job = previous.then(() => runInvoiceJob(directory, operation, args));
  const tail = job.catch(() => {});
  queues.set(directory, tail);
  void tail.then(() => { if (queues.get(directory) === tail) queues.delete(directory); });
  return job;
}
function runInvoiceJob(directory, operation, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../invoice-worker.mjs', import.meta.url), { workerData: { directory, operation, args }, execArgv: [] });
    let settled = false, message, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void worker.terminate(); }, 30000);
    worker.on('message', m => { message = m; });
    worker.on('error', e => { message = { ok: false, error: e.message }; });
    worker.on('exit', code => { clearTimeout(timer); if (settled) return; settled = true;
      if (timedOut) reject(new Error('开票巡检处理超时'));
      else if (code !== 0 || !message) reject(new Error(message?.error || `开票巡检进程退出（${code}）`));
      else if (message.ok) resolve(message.result); else reject(new Error(message.error));
    });
  });
}
