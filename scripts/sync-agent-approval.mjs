// Standalone module packages carry the exact reviewed runtime proof implementation.
// Run with --write only when deliberately updating the shared implementation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const approvalCopies = [
  'apps/purchase/lib/agent-approval.mjs',
  'apps/sales/lib/agent-approval.mjs',
  'apps/overview/lib/agent-approval.mjs',
  'apps/exporter/src/main/agent-approval.mjs',
];

export function synchronizeApproval(root, {write = false} = {}) {
  const sourcePath = path.join(root, 'desktop/agent-runtime/approval.mjs');
  const normalize = value => value.replace(/\r\n/g, '\n');
  const source = normalize(fs.readFileSync(sourcePath, 'utf8'));
  const sha256 = createHash('sha256').update(source).digest('hex');
  const mismatches = [];
  for (const relative of approvalCopies) {
    const target = path.join(root, relative);
    if (fs.existsSync(target) && normalize(fs.readFileSync(target, 'utf8')) === source) continue;
    if (write) {
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, source);
    } else mismatches.push(relative);
  }
  if (mismatches.length) throw new Error('Approval implementation is missing or stale: ' + mismatches.join(', '));
  return {ok: true, source: 'desktop/agent-runtime/approval.mjs', normalizedSha256: sha256, copies: approvalCopies, written: write};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(value => !['--check', '--write'].includes(value)) || args.includes('--check') && args.includes('--write')) {
    throw new Error('Use --check (default) or --write');
  }
  console.log(JSON.stringify(synchronizeApproval(path.resolve(import.meta.dirname, '..'), {write: args.includes('--write')})));
}
