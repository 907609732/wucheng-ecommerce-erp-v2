import fs from './native-fs.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import semver from 'semver';
import {MODULE_IDS, fail, inside, digest, verifyCatalog, extractZip, downloadPackage} from './package-format.mjs';

const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

// All mutating operations serialize under a cross-process lock. Business data is
// deliberately outside this store; adapters own backup, quiescence and health.
export class ModuleManager {
  constructor({root, hostVersion, publicKeys, platform = process.platform, arch = process.arch,
    lifecycle, onProgress = () => {}, fetchImpl = fetch}) {
    this.root = path.resolve(root); this.hostVersion = hostVersion;
    this.publicKeys = publicKeys; this.platform = platform; this.arch = arch;
    this.lifecycle = lifecycle; this.onProgress = onProgress; this.fetchImpl = fetchImpl;
    this.pending = new Map(); this.controllers = new Map(); this.progress = new Map();
    this.queue = Promise.resolve();
    fs.mkdirSync(this.root, {recursive: true});
    this.stateFile = path.join(this.root, 'installed.json');
    this.journalFile = path.join(this.root, 'transaction.json');
    try {
      const cached = read(path.join(this.root, 'catalog.json'), null);
      if (cached) this.catalog = this.validate(cached);
    } catch (error) {
      this.catalogError = error.message;
    }
  }
  validate(envelope) {
    return verifyCatalog(envelope, this.publicKeys, this);
  }
  setCatalog(envelope) {
    const next = this.validate(envelope);
    atomicJson(path.join(this.root, 'catalog.json'), envelope);
    this.catalog = next;
    return this.list();
  }
  state() { return read(this.stateFile, {schemaVersion: 1, packages: {}}); }
  list() {
    const state = this.state();
    return MODULE_IDS.map(id => {
      const installed = state.packages[id], available = this.catalog?.packages.find(p => p.id === id);
      return {id, installed, available, progress: this.progress.get(id),
        updateAvailable: !!(installed && available && semver.gt(available.version, installed.version))};
    });
  }
  emit(id, patch) {
    const value = {...this.progress.get(id), id, ...patch};
    this.progress.set(id, value); this.onProgress(value);
  }
  plan(id) {
    const result = [], resolvedPackages=[], seen = new Set();
    const walk = key => {
      if (seen.has(key)) return;
      const spec = this.catalog?.packages.find(p => p.id === key);
      if (!spec) throw fail('MODULE_UNAVAILABLE', '尚未取得此模块的官方发布清单');
      this.catalog.compatible(spec);
      for (const dep of spec.dependencies) walk(dep.id);
      seen.add(key);
      resolvedPackages.push(spec);
      const current = this.state().packages[key];
      if (!current || current.version !== spec.version || !fs.existsSync(current.root)) result.push(spec);
    };
    walk(id);
    return {id, packages: result, resolvedPackages, bytes: result.reduce((n, p) => n + p.bytes, 0)};
  }
  cancel(id) {
    const controller = this.controllers.get(id);
    if (!controller || this.progress.get(id)?.phase === 'activating') return {cancelled: false};
    controller.abort(); return {cancelled: true};
  }
  exclusive(fn) {
    const work = this.queue.then(async () => {
      const lock = path.join(this.root, 'install.lock');
      try {
        fs.writeFileSync(lock, JSON.stringify({pid: process.pid}), {flag: 'wx'});
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const owner = read(lock, null);
        let alive = true;
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
        }
        if (alive) throw fail('INSTALL_BUSY', '另一安装任务正在进行');
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, JSON.stringify({pid: process.pid}), {flag: 'wx'});
      }
      try {
        await this.recover();
        return await fn();
      } finally { fs.unlinkSync(lock); }
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async recover() {
    const journal = read(this.journalFile, null);
    if (!journal) return;
    if (journal.candidate?.root && this.state().packages[journal.id]?.root === journal.candidate.root) {
      await this.lifecycle?.complete?.(journal.candidate);
      fs.unlinkSync(this.journalFile);
      return;
    }
    // A crash may have occurred after migration but before activation. Never
    // blindly reconnect the old binary to a possibly upgraded ledger.
    if (journal.phase === 'activating') {
      if (!this.lifecycle?.recover) throw fail('RECOVERY_REQUIRED', '上次更新中断，需要先完成数据恢复检查');
      await this.lifecycle.recover(journal);
    }
    fs.unlinkSync(this.journalFile);
  }
  install(id, {offlineDirectory} = {}) {
    if (this.pending.has(id)) return this.pending.get(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.emit(id, {phase: 'queued', error: null});
    // Freeze the verified plan; a later catalog refresh cannot change this job.
    let planned;
    try { planned = this.plan(id); } catch (e) { this.controllers.delete(id); return Promise.reject(e); }
    const job = this.exclusive(async () => {
      for (const spec of planned.resolvedPackages) {
        controller.signal.throwIfAborted();
        await this.installOne(spec, {id, offlineDirectory, signal: controller.signal});
      }
      this.emit(id, {phase: 'installed'});
      return this.state().packages[id];
    }).catch(e => {
      this.emit(id, {phase: controller.signal.aborted ? 'cancelled' : 'error', error: e.message, code: e.code || 'INSTALL_FAILED'});
      throw e;
    }).finally(() => { this.pending.delete(id); this.controllers.delete(id); });
    this.pending.set(id, job); return job;
  }
  async installOne(spec, {id, offlineDirectory, signal}) {
    const state = this.state(), previous = state.packages[spec.id];
    if (previous?.version === spec.version && fs.existsSync(previous.root)) return;
    if (previous && semver.lt(spec.version, previous.version)) throw fail('DOWNGRADE_BLOCKED', '不能直接降级模块，请使用经验证的数据恢复流程');
    if (!this.lifecycle && spec.kind !== 'runtime') throw fail('LIFECYCLE_REQUIRED', '此模块尚未接入备份与启动检查，已阻止安装');
    // Prevent a runtime update from replacing a dependency required by an installed module.
    for (const installed of Object.values(state.packages)) {
      const dep = installed.dependencies?.find(d => d.id === spec.id);
      if (dep && !semver.satisfies(spec.version, dep.range)) throw fail('DEPENDENCY_IN_USE', '现有模块仍需要旧版运行环境');
    }
    const space = fs.statfsSync(this.root);
    if (space.bavail * space.bsize < spec.bytes + spec.unpackedBytes + 64 * 1024 ** 2) throw fail('NO_SPACE', '可用磁盘空间不足');
    const jobRoot = inside(this.root, 'staging/' + randomUUID());
    fs.mkdirSync(jobRoot, {recursive: true});
    const archive = path.join(jobRoot, 'package.zip'), stage = path.join(jobRoot, 'payload');
    let activationStarted = false, recoveryFailed = false, destination;
    try {
      this.emit(id, {phase: 'downloading', component: spec.id, received: 0, total: spec.bytes});
      if (offlineDirectory) {
        const source = inside(offlineDirectory, spec.archive);
        if (fs.statSync(source).size !== spec.bytes) throw fail('SIZE_MISMATCH', '离线扩展大小不符');
        fs.copyFileSync(source, archive, fs.constants.COPYFILE_EXCL);
      } else await downloadPackage(spec, archive, {signal, fetchImpl: this.fetchImpl, progress: p => this.emit(id, p)});
      signal.throwIfAborted();
      this.emit(id, {phase: 'verifying'});
      if (await digest(archive) !== spec.sha256) throw fail('HASH_MISMATCH', '扩展包校验失败，文件未安装');
      await extractZip(archive, stage, {maxBytes: spec.unpackedBytes, signal});
      if (!fs.statSync(inside(stage, spec.entry)).isFile()) throw fail('INVALID_ENTRY', '扩展入口文件缺失');
      signal.throwIfAborted();
      destination = inside(this.root, `packages/${spec.id}/${spec.version}-${randomUUID()}`);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.renameSync(stage, destination);
      const candidate = {...spec, root: destination, installedAt: new Date().toISOString()};
      await this.lifecycle?.checkIdle(spec.id, previous);
      const backup = await this.lifecycle?.backup(spec.id, previous);
      signal.throwIfAborted();
      this.emit(id, {phase: 'activating'});
      atomicJson(this.journalFile, {phase: 'activating', id: spec.id, previous, candidate, backup});
      activationStarted = true;
      await this.lifecycle?.activate(candidate, previous, backup);
      // The health check must validate real identity, paths, schema and version.
      await this.lifecycle?.health(candidate);
      state.packages[spec.id] = candidate;
      atomicJson(this.stateFile, state);
      await this.lifecycle?.complete?.(candidate);
      fs.unlinkSync(this.journalFile);
      activationStarted = false;
      this.emit(id, {phase: 'component-installed', component: spec.id});
    } catch (e) {
      if (activationStarted) {
        try { await this.recover(); }
        catch (recoveryError) { recoveryFailed = true; throw fail('RECOVERY_REQUIRED', `${e.message}；恢复检查未完成：${recoveryError.message}`); }
      }
      if (destination && !recoveryFailed && this.state().packages[spec.id]?.root !== destination) await this.removeOwned(destination);
      throw e;
    } finally { await this.removeOwned(jobRoot); }
  }
  async removeOwned(target) {
    const resolved = path.resolve(target);
    if (![path.join(this.root, 'staging') + path.sep, path.join(this.root, 'packages') + path.sep].some(p => resolved.startsWith(p))) {
      throw fail('INVALID_PATH', '拒绝删除扩展管理范围之外的文件');
    }
    await fs.promises.rm(resolved, {recursive: true, force: true, maxRetries:25, retryDelay:200});
  }
  uninstall(id) {
    return this.exclusive(async () => {
      if (!MODULE_IDS.includes(id)) throw fail('UNKNOWN_MODULE', '未知模块');
      const state = this.state(), current = state.packages[id];
      if (!current) return {removed: false};
      if (Object.values(state.packages).some(p => p.dependencies?.some(d => d.id === id))) throw fail('DEPENDENCY_IN_USE', '其他模块仍依赖此组件');
      if (!this.lifecycle && current.kind !== 'runtime') throw fail('LIFECYCLE_REQUIRED', '尚未接入安全停止检查');
      await this.lifecycle?.checkIdle(id, current);
      await this.lifecycle?.deactivate(current);
      delete state.packages[id]; atomicJson(this.stateFile, state);
      await this.removeOwned(inside(this.root, 'packages/' + id));
      return {removed: true, dataRetained: true};
    });
  }
  async inspectOffline(file) {
    const directory = inside(this.root, 'staging/offline-' + randomUUID());
    try {
      await extractZip(file, directory, {maxBytes: 16 * 1024 ** 3, maxEntries: 110});
      const catalogFile = path.join(directory, 'catalog.json');
      if (!fs.existsSync(catalogFile) || fs.statSync(catalogFile).size > 3 * 1024 ** 2) throw fail('INVALID_CATALOG', '离线包缺少官方签名清单');
      const envelope = JSON.parse(fs.readFileSync(catalogFile, 'utf8')), catalog = this.validate(envelope);
      const expected = new Set(['catalog.json', ...catalog.packages.map(p => p.archive)]);
      if (fs.readdirSync(directory).some(name => !expected.has(name))) throw fail('INVALID_OFFLINE_BUNDLE', '离线包包含未登记文件');
      for (const spec of catalog.packages) {
        const archive = inside(directory, spec.archive);
        if (!fs.existsSync(archive) || fs.statSync(archive).size !== spec.bytes || await digest(archive) !== spec.sha256) {
          throw fail('INCOMPLETE_OFFLINE_BUNDLE', '离线包不完整或已损坏：' + spec.id);
        }
      }
      // The UI keeps only this opaque handle, never an arbitrary filesystem path.
      const token = randomUUID();
      this.offlineBundles ||= new Map();
      this.offlineBundles.set(token, {directory, envelope, catalog});
      return {token, packages: catalog.packages};
    } catch (error) { await this.removeOwned(directory); throw error; }
  }
  installOffline(token, id) {
    const bundle = this.offlineBundles?.get(token);
    if (!bundle) return Promise.reject(fail('OFFLINE_SESSION_EXPIRED', '请重新选择离线包'));
    this.setCatalog(bundle.envelope);
    return this.install(id, {offlineDirectory: bundle.directory});
  }
  planOffline(token,id){
    const bundle=this.offlineBundles?.get(token);
    if(!bundle)throw fail('OFFLINE_SESSION_EXPIRED','请重新选择离线包');
    this.setCatalog(bundle.envelope);
    return this.plan(id);
  }
  async discardOffline(token) {
    const bundle = this.offlineBundles?.get(token);
    if (!bundle) return;
    if (this.pending.size) throw fail('INSTALL_BUSY', '请等待安装完成后关闭离线包');
    await this.removeOwned(bundle.directory); this.offlineBundles.delete(token);
  }
}
