import { Worker } from 'node:worker_threads';

export function businessJob(databasePath, directory, operation, args = [], onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../business-worker.mjs', import.meta.url), {
      execArgv: process.execArgv.filter(flag => !flag.startsWith('--input-type')),
      workerData: { databasePath, directory, operation, args }
    });
    let settled = false;
    const timer = setTimeout(() => { settled = true; worker.terminate(); reject(new Error('经营数据处理超时，请重试')); }, operation === 'syncDingTalk' ? 900000 : 120000);
    worker.on('message', message => { if(message.progress) {onProgress?.(message.progress);return;} settled = true; clearTimeout(timer); message.ok ? resolve(message.result) : reject(new Error(message.error)); });
    worker.once('error', error => { settled = true; clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (!settled) reject(new Error(`经营数据进程退出（${code}）`)); });
  });
}
