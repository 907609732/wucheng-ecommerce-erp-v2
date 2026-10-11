import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** 本地文件交接，不访问平台、不认定下载成功，也不自动入账。 */
export function receiveLocalBills(store, manifest, sourceDirectory) {
  if (manifest?.schemaVersion !== 1) throw new Error('账单交接清单版本必须为 1');
  const { shopId, month, files } = manifest;
  store.shop(shopId);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('账期必须为 YYYY-MM');
  if (!Array.isArray(files) || !files.length || files.length > 200) throw new Error('清单需要包含 1 至 200 个文件');
  const root = fs.realpathSync(sourceDirectory);
  const parts = files.map(item => {
    if (!['income', 'expense', 'tax'].includes(item.kind)) throw new Error('文件必须明确指定 income、expense 或 tax');
    if (typeof item.path !== 'string' || path.isAbsolute(item.path)) throw new Error('文件路径必须相对于清单目录');
    const file = path.resolve(root, item.path);
    const real = fs.realpathSync(file);
    const relative = path.relative(root, real);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('文件必须位于清单目录内');
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size === 0 || stat.size > 80 * 1024 * 1024) throw new Error('账单必须是非空文件且不超过 80MB');
    const name = path.basename(real);
    if (!['.xlsx', '.xls', '.csv'].includes(path.extname(name).toLowerCase())) throw new Error('只接收完整的 Excel 或 CSV 文件');
    const subtype = String(item.subtype || '').trim();
    if (!subtype || subtype.length > 120) throw new Error('每个文件须填写子类型（最多120字）');
    return { file: real, name, kind: item.kind, subtype, bytes: stat.size, sha256: sha256(fs.readFileSync(real)) };
  });
  const identities = parts.map(p => [p.kind, p.subtype, p.sha256]);
  if (new Set(identities.map(JSON.stringify)).size !== parts.length) throw new Error('清单内包含重复文件');
  identities.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const receiptId = sha256(JSON.stringify([shopId, month, identities]));
  store.db.exec('CREATE TABLE IF NOT EXISTS local_bill_receipts(id TEXT PRIMARY KEY, result TEXT NOT NULL)');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = store.db.prepare('SELECT result FROM local_bill_receipts WHERE id=?').get(receiptId);
    if (existing) {
      store.db.exec('COMMIT');
      return { ...JSON.parse(existing.result), duplicate: true };
    }
    const jobId = store.newJob(shopId, month);
    const batches = [];
    for (const kind of ['income', 'expense', 'tax']) {
      const selected = parts.filter(p => p.kind === kind);
      if (!selected.length) continue;
      const batchId = store.openBatch(jobId, shopId, month, kind, { transport: 'local-files', receiptId });
      const tokens = selected.map(part => store.addPart(batchId, { ...part, shopId, month, sourceTask: jobId }).token);
      store.closeBatch(batchId, { expected: [...new Set(selected.map(p => p.subtype))], message: '本地文件已接收，待人工确认范围和金额；未验证平台下载' });
      batches.push({ kind, batchId, tokens });
    }
    const missingKinds = ['income', 'expense', 'tax'].filter(k => !parts.some(p => p.kind === k));
    store.updateJob(jobId, { state: 'needs_review', message: '本地文件已接收，待核对入账', note: { transport: 'local-files', receiptId, missingKinds, platformDownloadVerified: false } });
    const result = { receiptId, jobId, state: 'awaiting_review', duplicate: false, platformDownloadVerified: false, missingKinds, batches };
    store.db.prepare('INSERT INTO local_bill_receipts(id,result) VALUES(?,?)').run(receiptId, JSON.stringify(result));
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
