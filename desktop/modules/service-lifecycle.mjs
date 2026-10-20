import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './module-manager.mjs';
import {fail, inside} from './package-format.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const readRegistry = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

export function createServiceLifecycle({services, dataRoot, backupRoot, getInstalled}) {
  const runtime = () => {
    const node = getInstalled('node-runtime');
    if (!node) throw fail('MISSING_DEPENDENCY', '请先安装共享 Node.js 运行环境');
    return inside(node.root, node.entry);
  };
  const supported = id => {
    if (!['purchase', 'sales', 'overview'].includes(id)) throw fail('MODULE_NOT_READY', '此扩展的启动适配尚未完成');
  };
  async function stopped(id) {
    const cap = await services.capabilities(id);
    if (!cap) return;
    if (cap.busy) throw fail('SERVICE_BUSY', '扩展正在执行任务，无法更新');
    await services.stop(id);
    for (let i = 0; i < 100; i++) {
      if (!await services.capabilities(id)) return;
      await wait(100);
    }
    throw fail('STOP_TIMEOUT', '后台未能停止，已中止更新');
  }
  function checkDatabase(file) {
    const result = spawnSync(runtime(), ['--input-type=module', '-e',
      "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('PRAGMA integrity_check').get();d.close();if(r.integrity_check!=='ok')process.exit(2);",
      file], {windowsHide: true, encoding: 'utf8', timeout: 30000});
    if (result.status !== 0) throw fail('DATABASE_CHECK_FAILED', '账本完整性检查失败，已中止更新');
  }
  return {
    async checkIdle(id) {
      if (id.endsWith('-runtime')) return;
      supported(id);
      const cap = await services.capabilities(id);
      if (cap?.busy) throw fail('SERVICE_BUSY', '扩展正在执行任务，无法更新');
    },
    async backup(id) {
      if (id.endsWith('-runtime')) return null;
      supported(id);
      const registry = readRegistry(services.registryFile);
      const old = services.config(id), explicit = Object.hasOwn(registry, id);
      const existing = fs.existsSync(path.join(old.dataDir, old.db));
      if (explicit && !existing && !old.allowInitialize) throw fail('MISSING_LEDGER', '原账本不存在，已阻止创建空账本');
      await stopped(id);
      const directory = path.join(backupRoot, id + '-' + randomUUID());
      fs.mkdirSync(directory, {recursive: true});
      const targetData = existing || explicit ? old.dataDir : path.join(dataRoot, id);
      if (existing) {
        checkDatabase(path.join(old.dataDir, old.db));
        fs.cpSync(old.dataDir, path.join(directory, 'data'), {recursive: true, filter: file => {
          if (fs.lstatSync(file).isSymbolicLink()) throw fail('UNSAFE_DATA_PATH', '数据目录包含链接，需要先核对真实位置');
          return !['.integration-start.lock', '.integration-runtime.json'].includes(path.basename(file));
        }});
        checkDatabase(path.join(directory, 'data', old.db));
      }
      const backup = {directory, dataDir: targetData, previousRegistry: registry[id] || null,
        previousConfig: existing ? old : null, hadData: existing, createdAt: new Date().toISOString()};
      atomicJson(path.join(directory, 'backup.json'), backup);
      return backup;
    },
    async activate(candidate, _previous, backup) {
      if (candidate.kind === 'runtime') return;
      supported(candidate.id);
      const registry = readRegistry(services.registryFile);
      registry[candidate.id] = {
        ...services.config(candidate.id), root: candidate.root, dataDir: backup.dataDir,
        version: candidate.version, managed: true, uninstalled:false, nodePath: runtime(),
        allowInitialize: !backup.hadData, maintenance: true
      };
      atomicJson(services.registryFile, registry);
      await services.ensure(candidate.id);
    },
    async health(candidate) {
      if (candidate.kind === 'runtime') {
        if (candidate.id === 'node-runtime') {
          const result = spawnSync(inside(candidate.root, candidate.entry), ['--version'], {encoding: 'utf8', windowsHide: true, timeout: 10000});
          if (result.status !== 0 || result.stdout.trim() !== 'v' + candidate.version) throw fail('RUNTIME_CHECK_FAILED', '共享运行环境版本校验失败');
        }
        return;
      }
      const cap = await services.capabilities(candidate.id);
      if (!cap || cap.maintenance !== true || cap.version !== candidate.version) throw fail('HEALTH_CHECK_FAILED', '新模块未能进入安全检查状态');
      const config = services.config(candidate.id);
      checkDatabase(path.join(config.dataDir, config.db));
    },
    async complete(candidate) {
      if (candidate.kind === 'runtime') return;
      const cap = await services.capabilities(candidate.id);
      if (!cap) await services.ensure(candidate.id);
      await services.request(candidate.id, '/maintenance/activate', {method: 'POST', body: {confirm: true}});
      const registry = readRegistry(services.registryFile);
      registry[candidate.id].maintenance = false;
      registry[candidate.id].allowInitialize = false;
      atomicJson(services.registryFile, registry);
    },
    async recover(journal) {
      if (journal.candidate?.kind === 'runtime') return;
      supported(journal.id);
      const cap = await services.capabilities(journal.id);
      if (cap && cap.maintenance !== true) throw fail('RECOVERY_REVIEW_REQUIRED', '模块已允许业务编辑，不能自动覆盖账本；请核对中断记录');
      await stopped(journal.id);
      const b = journal.backup;
      if (!b?.directory || !fs.existsSync(path.join(b.directory, 'backup.json'))) throw fail('MISSING_BACKUP', '恢复备份缺失');
      if (!path.resolve(b.directory).startsWith(path.resolve(backupRoot) + path.sep) ||
          path.resolve(b.dataDir) !== path.resolve(services.config(journal.id).dataDir)) throw fail('INVALID_RECOVERY_PATH', '恢复路径与已登记的数据目录不符');
      // Preserve the failed candidate's data for investigation. Never delete a ledger.
      if (fs.existsSync(b.dataDir)) fs.renameSync(b.dataDir, b.dataDir + '.failed-' + randomUUID());
      if (b.hadData) fs.cpSync(path.join(b.directory, 'data'), b.dataDir, {recursive: true});
      const registry = readRegistry(services.registryFile);
      if (b.previousRegistry) registry[journal.id] = b.previousRegistry;
      else if (b.previousConfig) registry[journal.id] = b.previousConfig;
      else delete registry[journal.id];
      atomicJson(services.registryFile, registry);
    },
    async deactivate(candidate) {
      if (candidate.kind === 'runtime') return;
      supported(candidate.id); await stopped(candidate.id);
      // Keep dataDir as an explicit record so reinstall never loses the old ledger.
      const registry = readRegistry(services.registryFile);
      if (registry[candidate.id]) {
        registry[candidate.id].uninstalled = true;
        atomicJson(services.registryFile, registry);
      }
    }
  };
}
