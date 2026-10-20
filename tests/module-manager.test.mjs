import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync, sign} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {ModuleManager, atomicJson} from '../desktop/modules/module-manager.mjs';
import {digest, safeRelative, verifyCatalog, extractZip, downloadPackage} from '../desktop/modules/package-format.mjs';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const keys = {test: publicKey.export({type: 'spki', format: 'pem'})};
function envelope(packages) {
  const payload = Buffer.from(JSON.stringify({schemaVersion: 1, packages}));
  return {format: 'lingtu-catalog/v1', keyId: 'test', payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64')};
}
async function fixture(t, {lifecycle, version = '1.0.0', id = 'purchase', kind = 'service'} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingtu-modules-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const offline = path.join(root, 'offline'); fs.mkdirSync(offline);
  const archive = path.join(offline, id + '.zip');
  const zip = new yazl.ZipFile(), content = Buffer.from('export const healthy = true;\n');
  zip.addBuffer(content, 'server.mjs'); zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(archive));
  const spec = {id, version, hostRange: '>=0.7.1 <1', platform: 'win32', arch: 'x64', kind,
    archive: id + '.zip', bytes: fs.statSync(archive).size, unpackedBytes: content.length, sha256: await digest(archive),
    entry: 'server.mjs', dependencies: [], url: `https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/test/${id}.zip`};
  const manager = new ModuleManager({root: path.join(root, 'store'), hostVersion: '0.7.1', publicKeys: keys, platform: 'win32', arch: 'x64', lifecycle});
  manager.setCatalog(envelope([spec]));
  return {root, offline, archive, spec, manager};
}
const hooks = overrides => ({
  async checkIdle() {}, async backup() { return {test: true}; }, async activate() {},
  async health() {}, async recover() {}, async deactivate() {}, ...overrides
});

test('signed offline install deduplicates concurrent requests and retains data on uninstall', async t => {
  let activations = 0;
  const f = await fixture(t, {lifecycle: hooks({async activate() { activations++; }})});
  const data = path.join(f.root, 'ledger.sqlite'); fs.writeFileSync(data, 'private ledger');
  const a = f.manager.install('purchase', {offlineDirectory: f.offline});
  const b = f.manager.install('purchase', {offlineDirectory: f.offline});
  assert.equal(a, b);
  const installed = await a;
  assert.equal(activations, 1);
  assert.ok(fs.existsSync(path.join(installed.root, 'server.mjs')));
  await f.manager.uninstall('purchase');
  assert.equal(fs.readFileSync(data, 'utf8'), 'private ledger');
  assert.equal(f.manager.state().packages.purchase, undefined);
});
test('tampering with a catalog or signing with another key is rejected', async t => {
  const f = await fixture(t);
  const signed = envelope([f.spec]);
  signed.payload = Buffer.from(JSON.stringify({schemaVersion: 1, packages: [{...f.spec, entry: 'other.mjs'}]})).toString('base64');
  assert.throws(() => f.manager.setCatalog(signed), {code: 'INVALID_SIGNATURE'});
  assert.throws(() => verifyCatalog(envelope([f.spec]), {}), {code: 'UNTRUSTED_PACKAGE'});
});
test('corrupt archive never activates or changes installed state', async t => {
  let activated = false;
  const f = await fixture(t, {lifecycle: hooks({async activate() { activated = true; }})});
  const bytes = fs.readFileSync(f.archive); bytes[40] ^= 1; fs.writeFileSync(f.archive, bytes);
  await assert.rejects(f.manager.install('purchase', {offlineDirectory: f.offline}), {code: 'HASH_MISMATCH'});
  assert.equal(activated, false); assert.deepEqual(f.manager.state().packages, {});
});
test('busy service blocks activation', async t => {
  let backedUp = false;
  const f = await fixture(t, {lifecycle: hooks({
    async checkIdle() { throw new Error('任务进行中'); },
    async backup() { backedUp = true; }
  })});
  await assert.rejects(f.manager.install('purchase', {offlineDirectory: f.offline}), /任务进行中/);
  assert.equal(backedUp, false); assert.deepEqual(f.manager.state().packages, {});
});
test('health failure runs recovery and retains the prior version', async t => {
  let recovered = false;
  const f = await fixture(t, {lifecycle: hooks()});
  const old = await f.manager.install('purchase', {offlineDirectory: f.offline});
  f.manager.setCatalog(envelope([{...f.spec, version: '1.0.1'}]));
  f.manager.lifecycle = hooks({async health() { throw Error('故意制造校验差异'); }, async recover(journal) {
    assert.equal(journal.previous.root, old.root); recovered = true;
  }});
  await assert.rejects(f.manager.install('purchase', {offlineDirectory: f.offline}), /故意制造/);
  assert.equal(recovered, true);
  assert.equal(f.manager.state().packages.purchase.root, old.root);
  assert.ok(fs.existsSync(old.root));
});
test('interrupted migration blocks new operations until recovery succeeds', async t => {
  const f = await fixture(t, {lifecycle: hooks({async recover() { throw Error('需要检查数据'); }})});
  atomicJson(f.manager.journalFile, {phase: 'activating', id: 'purchase'});
  await assert.rejects(f.manager.install('purchase', {offlineDirectory: f.offline}), /需要检查数据/);
  assert.ok(fs.existsSync(f.manager.journalFile));
  assert.deepEqual(f.manager.state().packages, {});
});
test('missing lifecycle cannot accidentally run business packages', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.install('purchase', {offlineDirectory: f.offline}), {code: 'LIFECYCLE_REQUIRED'});
});
test('platform compatibility, dependency graph and download origin are checked', async t => {
  const f = await fixture(t);
  f.manager.setCatalog(envelope([{...f.spec, arch: 'arm64'}]));
  assert.throws(() => f.manager.plan('purchase'), {code: 'INCOMPATIBLE_PACKAGE'});
  assert.throws(() => f.manager.setCatalog(envelope([{...f.spec, dependencies: [{id: 'purchase', range: '*'}]}])), {code: 'DEPENDENCY_CYCLE'});
  assert.throws(() => f.manager.setCatalog(envelope([{...f.spec, dependencies: [{id: 'node-runtime', range: '^24'}]}])), {code: 'MISSING_DEPENDENCY'});
  assert.throws(() => f.manager.setCatalog(envelope([{...f.spec, url: 'http://127.0.0.1/private'}])), {code: 'INVALID_URL'});
});
test('Windows path traversal, device paths, alternate streams and duplicate ZIP paths are rejected', async t => {
  for (const value of ['../ledger.sqlite', 'C:/data', 'a\\b', 'a:stream', 'CON.txt', 'x/.. /a', '/root', 'a//b']) {
    assert.throws(() => safeRelative(value), {code: 'INVALID_PATH'});
  }
  const f = await fixture(t);
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('1'), 'a.txt'); zip.addBuffer(Buffer.from('2'), 'A.txt'); zip.end();
  const file = path.join(f.root, 'duplicates.zip');
  await pipeline(zip.outputStream, fs.createWriteStream(file));
  await assert.rejects(extractZip(file, path.join(f.root, 'extract'), {maxBytes: 100}), {code: 'DUPLICATE_PATH'});
});
test('unpacked size and network content size are bounded', async t => {
  const f = await fixture(t);
  await assert.rejects(extractZip(f.archive, path.join(f.root, 'extract'), {maxBytes: 1}), {code: 'PACKAGE_TOO_LARGE'});
  await assert.rejects(downloadPackage({...f.spec, bytes: 1}, path.join(f.root, 'download.zip'), {
    fetchImpl: async () => new Response(Buffer.from('too long'))
  }), {code: 'SIZE_MISMATCH'});
});
test('unsafe redirect is rejected before requesting its destination', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(downloadPackage(f.spec, path.join(f.root, 'download.zip'), {
    fetchImpl: async () => { calls++; return new Response(null, {status: 302, headers: {location: 'http://127.0.0.1/secret'}}); }
  }), {code: 'INVALID_URL'});
  assert.equal(calls, 1);
});
test('offline bundle verifies all dependencies before exposing an install token', async t => {
  const f=await fixture(t,{lifecycle:hooks()});
  const zip=new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(envelope([f.spec]))),'catalog.json');
  zip.addFile(f.archive,f.spec.archive);zip.end();
  const bundle=path.join(f.root,'offline.zip');
  await pipeline(zip.outputStream,fs.createWriteStream(bundle));
  const inspected=await f.manager.inspectOffline(bundle);
  await f.manager.installOffline(inspected.token,'purchase');
  assert.equal(f.manager.state().packages.purchase.version,'1.0.0');
  await f.manager.discardOffline(inspected.token);
  await assert.rejects(f.manager.installOffline(inspected.token,'purchase'),{code:'OFFLINE_SESSION_EXPIRED'});
});
test('a queued cancellation cannot activate the package',async t=>{
  const f=await fixture(t,{lifecycle:hooks()});
  const pending=f.manager.install('purchase',{offlineDirectory:f.offline});
  assert.equal(f.manager.cancel('purchase').cancelled,true);
  await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(f.manager.state().packages,{});
});
test('incomplete offline bundle is rejected',async t=>{
  const f=await fixture(t);
  const zip=new yazl.ZipFile();zip.addBuffer(Buffer.from(JSON.stringify(envelope([f.spec]))),'catalog.json');zip.end();
  const file=path.join(f.root,'missing.zip');await pipeline(zip.outputStream,fs.createWriteStream(file));
  await assert.rejects(f.manager.inspectOffline(file),{code:'INCOMPLETE_OFFLINE_BUNDLE'});
});
test('downgrade is blocked without changing the installed version',async t=>{
  const f=await fixture(t,{lifecycle:hooks()});
  await f.manager.install('purchase',{offlineDirectory:f.offline});
  f.manager.setCatalog(envelope([{...f.spec,version:'0.9.0'}]));
  await assert.rejects(f.manager.install('purchase',{offlineDirectory:f.offline}),{code:'DOWNGRADE_BLOCKED'});
  assert.equal(f.manager.state().packages.purchase.version,'1.0.0');
});
test('disk exhaustion blocks installation before touching a service',async t=>{
  let touched=false;
  const f=await fixture(t,{lifecycle:hooks({async backup(){touched=true;}})});
  const original=fs.statfsSync;
  fs.statfsSync=()=>({bavail:0,bsize:4096});
  try{await assert.rejects(f.manager.install('purchase',{offlineDirectory:f.offline}),{code:'NO_SPACE'});}
  finally{fs.statfsSync=original;}
  assert.equal(touched,false);
});
test('network interruption can be retried without duplicate activation',async t=>{
  let attempts=0,activations=0;
  const f=await fixture(t,{lifecycle:hooks({async activate(){activations++;}})});
  f.manager.fetchImpl=async()=>{
    if(++attempts===1)throw Error('模拟连接中断');
    return new Response(fs.readFileSync(f.archive));
  };
  await assert.rejects(f.manager.install('purchase'),/连接中断/);
  await f.manager.install('purchase');
  assert.equal(activations,1);
});
test('corrupt cached catalog does not prevent offline recovery',async t=>{
  const f=await fixture(t);
  fs.writeFileSync(path.join(f.manager.root,'catalog.json'),'not json');
  const next=new ModuleManager({root:f.manager.root,hostVersion:'0.7.1',publicKeys:keys,platform:'win32',arch:'x64'});
  assert.ok(next.catalogError);assert.equal(next.catalog,undefined);
  next.setCatalog(envelope([f.spec]));
  assert.equal(next.plan('purchase').id,'purchase');
});
