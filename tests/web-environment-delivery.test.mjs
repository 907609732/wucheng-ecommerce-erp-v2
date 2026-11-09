import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyDelivery } from '../deploy/environments/verify-delivery.mjs';

test('delivery gate accepts only three uniquely identified, hash-verified accepted packages', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const common = { schemaVersion: 1, version: '1.2.3', commit: 'a'.repeat(40), runId: '12345', nodeVersion: '24.22.2', commonSourceSHA256: 'b'.repeat(64) };
  const targets = ['windows-x64', 'linux-x64', 'fnos-x64'];
  for (const target of targets) {
    const dir = path.join(root, target); fs.mkdirSync(dir);
    const pkg = `erp-${target}.zip`; fs.writeFileSync(path.join(dir, pkg), `${target}-package`);
    const build = { ...common, target };
    fs.writeFileSync(path.join(dir, 'environment-build.json'), JSON.stringify(build));
    fs.writeFileSync(path.join(dir, 'environment-acceptance.json'), JSON.stringify({ schemaVersion: 1, ok: true, cleanupComplete: true, target, version: common.version, commit: common.commit, runId: common.runId, nodeVersion: build.nodeVersion, checks: [] }));
    const packageSHA256 = createHash('sha256').update(fs.readFileSync(path.join(dir, pkg))).digest('hex');
    fs.writeFileSync(path.join(dir, 'environment-receipt.json'), JSON.stringify({ schemaVersion: 1, target, packageFile: pkg, packageSHA256, acceptance: { passed: true, evidence: ['environment-acceptance.json'] } }));
  }
  const result = verifyDelivery(root, path.join(root, 'DELIVERY.json'));
  assert.deepEqual(result.targets.map((x) => x.target).sort(), targets.sort());
  assert(fs.existsSync(path.join(root, 'DELIVERY.json')));
  const badReceipt = path.join(root, 'linux-x64', 'environment-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(badReceipt)); receipt.acceptance.passed = false;
  fs.writeFileSync(badReceipt, JSON.stringify(receipt));
  assert.throws(() => verifyDelivery(root, path.join(root, 'bad.json')), /验收|acceptance/i);
});

test('delivery gate rejects missing and duplicate targets and mismatched identity or bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-delivery-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyDelivery(root, path.join(root, 'x.json')), /目标|target/i);
  const common = { schemaVersion: 1, version: '1.2.3', commit: 'a'.repeat(40), runId: '12345', nodeVersion: '24.22.2', commonSourceSHA256: 'b'.repeat(64) };
  const addTarget = (target, dirName = target) => {
    const dir = path.join(root, dirName); fs.mkdirSync(dir);
    const pkg = `${dirName}.zip`; fs.writeFileSync(path.join(dir, pkg), dirName);
    const build = { ...common, target };
    fs.writeFileSync(path.join(dir, 'environment-build.json'), JSON.stringify(build));
    fs.writeFileSync(path.join(dir, 'environment-acceptance.json'), JSON.stringify({ schemaVersion: 1, ok: true, cleanupComplete: true, target, version: common.version, commit: common.commit, runId: common.runId, nodeVersion: build.nodeVersion }));
    fs.writeFileSync(path.join(dir, 'environment-receipt.json'), JSON.stringify({ schemaVersion: 1, target, packageFile: pkg, packageSHA256: createHash('sha256').update(dirName).digest('hex'), acceptance: { passed: true, evidence: ['environment-acceptance.json'] } }));
    return dir;
  };
  const win = addTarget('windows-x64'); addTarget('linux-x64'); addTarget('fnos-x64');
  const duplicate = addTarget('windows-x64', 'duplicate');
  assert.throws(() => verifyDelivery(root, path.join(root, 'duplicate-output.json')), /重复|duplicate/i);
  fs.rmSync(path.join(duplicate, 'environment-receipt.json'));
  assert.throws(() => verifyDelivery(root, path.join(root, 'expected-node-output.json'), { nodeVersion: '22.0.0' }), /workflow.*Node/i);
  const linuxBuild = path.join(root, 'linux-x64', 'environment-build.json');
  const savedBuild = fs.readFileSync(linuxBuild, 'utf8');
  const mismatchedBuild = JSON.parse(savedBuild); mismatchedBuild.commit = 'c'.repeat(40);
  fs.writeFileSync(linuxBuild, JSON.stringify(mismatchedBuild));
  assert.throws(() => verifyDelivery(root, path.join(root, 'mismatch-output.json')), /不一致|workflow/i);
  fs.writeFileSync(linuxBuild, savedBuild);
  const wrongNodeBuild = JSON.parse(savedBuild); wrongNodeBuild.nodeVersion = '22.0.0';
  fs.writeFileSync(linuxBuild, JSON.stringify(wrongNodeBuild));
  assert.throws(() => verifyDelivery(root, path.join(root, 'node-output.json')), /字段无效|Node/i);
  fs.writeFileSync(linuxBuild, savedBuild);
  fs.appendFileSync(path.join(win, 'windows-x64.zip'), 'tampered');
  assert.throws(() => verifyDelivery(root, path.join(root, 'hash-output.json')), /SHA256/i);
});
