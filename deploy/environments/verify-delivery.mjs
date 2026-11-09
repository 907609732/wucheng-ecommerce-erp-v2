import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const TARGETS = ['windows-x64', 'linux-x64', 'fnos-x64'];
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
function inside(root, candidate) { const rel = path.relative(root, candidate); return rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); }
function regularFileNoLinks(root, candidate) {
  if (!inside(root, candidate)) return false;
  let cursor = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    cursor = path.join(cursor, part);
    const st = fs.lstatSync(cursor);
    if (st.isSymbolicLink()) return false;
  }
  return fs.statSync(candidate).isFile();
}
export function verifyDelivery(root, outputPath = path.join(root, 'DELIVERY.json'), expected = {}) {
  root = fs.realpathSync(path.resolve(root));
  const receipts = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'environment-receipt.json') receipts.push({ dir, path: p, receipt: readJson(p) });
    }
  }
  walk(root);
  const byTarget = new Map();
  for (const item of receipts) {
    const t = item.receipt.target;
    if (!TARGETS.includes(t)) throw new Error(`未知交付目标: ${t}`);
    if (byTarget.has(t)) throw new Error(`重复交付目标: ${t}`);
    byTarget.set(t, item);
  }
  for (const target of TARGETS) if (!byTarget.has(target)) throw new Error(`缺少交付目标: ${target}`);
  let identity;
  const outputs = [];
  for (const target of TARGETS) {
    const { dir, receipt } = byTarget.get(target);
    const buildPath = path.join(dir, 'environment-build.json');
    if (!regularFileNoLinks(root, buildPath)) throw new Error(`${target} 缺少有效 environment-build.json`);
    const build = readJson(buildPath);
    if (build.schemaVersion !== 1 || build.target !== target) throw new Error(`${target} 元数据 schema/target 无效`);
    if (!/^\d+\.\d+\.\d+$/.test(build.version) || !/^[a-f0-9]{40}$/i.test(build.commit) || !/^\d+$/.test(String(build.runId)) || build.nodeVersion !== '24.22.2' || !/^[a-f0-9]{64}$/i.test(build.commonSourceSHA256)) throw new Error(`${target} 元数据字段无效`);
    const current = { version: build.version, commit: build.commit.toLowerCase(), runId: String(build.runId), nodeVersion: build.nodeVersion, commonSourceSHA256: build.commonSourceSHA256.toLowerCase() };
    if (identity && Object.keys(identity).some((k) => identity[k] !== current[k])) throw new Error('平台间 commit/version/runId/nodeVersion/commonSourceSHA256 不一致');
    identity ??= current;
    if ((expected.commit && current.commit !== expected.commit.toLowerCase()) || (expected.runId && current.runId !== String(expected.runId)) || (expected.version && current.version !== expected.version) || (expected.nodeVersion && current.nodeVersion !== expected.nodeVersion)) throw new Error(`${target} 元数据与当前 workflow SHA/run/version/Node 不符`);
    if (receipt.schemaVersion !== 1 || receipt.target !== target || typeof receipt.packageFile !== 'string' || path.basename(receipt.packageFile) !== receipt.packageFile || !/^[a-f0-9]{64}$/i.test(receipt.packageSHA256)) throw new Error(`${target} receipt 无效`);
    const packagePath = path.join(dir, receipt.packageFile);
    if (!regularFileNoLinks(root, packagePath)) throw new Error(`${target} 实际包缺失或为链接`);
    const actual = sha256(packagePath);
    if (actual !== receipt.packageSHA256.toLowerCase()) throw new Error(`${target} 实际包 SHA256 不符`);
    if (receipt.acceptance?.passed !== true || !Array.isArray(receipt.acceptance.evidence) || !receipt.acceptance.evidence.includes('environment-acceptance.json')) throw new Error(`${target} acceptance 未通过或缺少规范证据`);
    const acceptancePath = path.join(dir, 'environment-acceptance.json');
    if (!regularFileNoLinks(root, acceptancePath) || !fs.statSync(acceptancePath).size) throw new Error(`${target} acceptance evidence 缺失或为空`);
    const acceptance = readJson(acceptancePath);
    const fields = ['target', 'version', 'commit', 'runId', 'nodeVersion'];
    if (acceptance.schemaVersion !== 1 || acceptance.ok !== true || acceptance.cleanupComplete !== true || fields.some((k) => String(acceptance[k]).toLowerCase() !== String(build[k]).toLowerCase())) throw new Error(`${target} 验收证据失败或身份与元数据不符`);
    for (const evidence of receipt.acceptance.evidence) {
      if (typeof evidence !== 'string' || path.isAbsolute(evidence) || evidence.split(/[\\/]/).includes('..') || !regularFileNoLinks(root, path.join(dir, evidence))) throw new Error(`${target} acceptance evidence 无效: ${evidence}`);
    }
    outputs.push({ target, ...current, packageFile: receipt.packageFile, packageSHA256: actual, acceptance: 'passed' });
  }
  const result = { schemaVersion: 1, ...identity, targets: outputs };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [rootArg, outputArg] = process.argv.slice(2);
  if (!rootArg) throw new Error('用法: node verify-delivery.mjs <download-root> [DELIVERY.json]');
  const root = path.resolve(rootArg);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const checkoutVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  if (process.env.ERP_VERSION !== checkoutVersion) throw new Error('ERP_VERSION does not match this checkout package.json');
  const result = verifyDelivery(root, outputArg ? path.resolve(outputArg) : path.join(root, 'DELIVERY.json'), { commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, version: process.env.ERP_VERSION, nodeVersion: '24.22.2' });
  console.log(JSON.stringify(result, null, 2));
}
