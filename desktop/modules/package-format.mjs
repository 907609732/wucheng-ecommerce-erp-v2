import fs from './native-fs.mjs';
import path from 'node:path';
import {createHash, verify} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import yauzl from 'yauzl';
import semver from 'semver';

export const MODULE_IDS = ['warehouse', 'purchase', 'sales', 'overview', 'exporter', 'node-runtime', 'browser-runtime'];
export function fail(code, message) {
  return Object.assign(new Error(message), {code});
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') ||
      value.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) ||
        /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw fail('INVALID_PATH', '扩展包包含不安全的文件路径');
  }
  return value;
}
export function inside(root, relative) {
  safeRelative(relative);
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw fail('INVALID_PATH', '文件越出扩展目录');
  return target;
}
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function verifyCatalog(envelope, publicKeys, {hostVersion, platform = process.platform, arch = process.arch} = {}) {
  if (envelope?.format !== 'lingtu-catalog/v1' || typeof envelope.payload !== 'string' ||
      typeof envelope.signature !== 'string' || !Object.hasOwn(publicKeys, envelope.keyId)) {
    throw fail('UNTRUSTED_PACKAGE', '扩展清单不是受信任的官方清单');
  }
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.length > 2 * 1024 * 1024 || !verify(null, bytes, publicKeys[envelope.keyId], Buffer.from(envelope.signature, 'base64'))) {
    throw fail('INVALID_SIGNATURE', '扩展清单签名验证失败');
  }
  const catalog = JSON.parse(bytes.toString('utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.packages) || catalog.packages.length > 100) {
    throw fail('INVALID_CATALOG', '扩展清单格式不受支持');
  }
  const ids = new Set();
  for (const p of catalog.packages) {
    if (!MODULE_IDS.includes(p.id) || ids.has(p.id) || !semver.valid(p.version) ||
        !semver.validRange(p.hostRange) || !/^[a-f0-9]{64}$/.test(p.sha256) ||
        !Number.isSafeInteger(p.bytes) || p.bytes <= 0 ||
        !Number.isSafeInteger(p.unpackedBytes) || p.unpackedBytes <= 0 ||
        p.unpackedBytes > 8 * 1024 ** 3 || !Array.isArray(p.dependencies)) {
      throw fail('INVALID_CATALOG', '扩展版本或文件信息无效');
    }
    ids.add(p.id);
    safeRelative(p.archive);
    if (p.archive.includes('/')) throw fail('INVALID_CATALOG', '压缩包名称无效');
    safeRelative(p.entry);
    if (!['service', 'electron', 'runtime'].includes(p.kind)) throw fail('INVALID_CATALOG', '扩展类型无效');
    const url = new URL(p.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
        !url.pathname.startsWith('/907609732/wucheng-ecommerce-erp-v2/releases/download/') ||
        url.username || url.password) throw fail('INVALID_URL', '扩展下载地址不属于官方发布仓库');
    for (const d of p.dependencies) {
      if (!MODULE_IDS.includes(d.id) || !semver.validRange(d.range)) throw fail('INVALID_CATALOG', '扩展依赖信息无效');
    }
  }
  // Validate the whole graph before any download or mutation.
  const visited = new Set(), visiting = new Set();
  const walk = id => {
    if (visiting.has(id)) throw fail('DEPENDENCY_CYCLE', '扩展存在循环依赖');
    if (visited.has(id)) return;
    const p = catalog.packages.find(x => x.id === id);
    visiting.add(id);
    for (const d of p.dependencies) {
      const dep = catalog.packages.find(x => x.id === d.id);
      if (!dep || !semver.satisfies(dep.version, d.range)) throw fail('MISSING_DEPENDENCY', '扩展缺少兼容的依赖包');
      walk(d.id);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) walk(id);
  return {
    ...catalog,
    compatible(p) {
      if (p.platform !== platform || p.arch !== arch || !semver.satisfies(hostVersion, p.hostRange)) {
        throw fail('INCOMPATIBLE_PACKAGE', '此扩展不支持当前启动台版本或系统架构');
      }
      return p;
    }
  };
}

export async function extractZip(file, target, {maxBytes, maxEntries = 100000, signal} = {}) {
  fs.mkdirSync(target, {recursive: true});
  if (fs.readdirSync(target).length) throw fail('INVALID_STAGING', '安装临时目录必须为空');
  const zip = await new Promise((resolve, reject) => yauzl.open(file, {lazyEntries: true, strictFileNames: true, validateEntrySizes: true}, (e, z) => e ? reject(e) : resolve(z)));
  let total = 0, count = 0;
  const names = new Set();
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          signal?.throwIfAborted();
          if (++count > maxEntries) throw fail('PACKAGE_TOO_LARGE', '扩展包文件数量超过限制');
          const directory = entry.fileName.endsWith('/');
          const name = safeRelative(directory ? entry.fileName.slice(0, -1) : entry.fileName);
          const key = name.toLowerCase();
          if (names.has(key)) throw fail('DUPLICATE_PATH', '扩展包包含重复文件');
          names.add(key);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if ((mode && mode !== 0x8000 && mode !== 0x4000) || (entry.generalPurposeBitFlag & 1)) {
            throw fail('UNSAFE_ENTRY', '不支持链接、特殊文件或加密压缩包');
          }
          total += entry.uncompressedSize;
          if (!Number.isSafeInteger(maxBytes) || total > maxBytes) throw fail('PACKAGE_TOO_LARGE', '解压大小超过官方清单限制');
          const output = inside(target, name);
          if (directory) fs.mkdirSync(output, {recursive: true});
          else {
            fs.mkdirSync(path.dirname(output), {recursive: true});
            const input = await new Promise((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s)));
            await pipeline(input, fs.createWriteStream(output, {flags: 'wx'}), {signal});
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  return {bytes: total, entries: count};
}

export async function downloadPackage(spec, file, {signal, progress = () => {}, fetchImpl = fetch} = {}) {
  let url = spec.url, response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) {
      throw fail('INVALID_URL', '下载重定向地址不受信任');
    }
    response = await fetchImpl(url, {signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30 * 60 * 1000)]), redirect: 'manual'});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    url = new URL(response.headers.get('location'), url).href;
    response = null;
  }
  if (!response?.ok || !response.body) throw fail('DOWNLOAD_FAILED', '无法下载扩展，请重试或使用完整离线包');
  let received = 0;
  const meter = new Transform({transform(chunk, _encoding, callback) {
    received += chunk.length;
    if (received > spec.bytes) return callback(fail('SIZE_MISMATCH', '下载文件大小与清单不符'));
    progress({received, total: spec.bytes});
    callback(null, chunk);
  }});
  await pipeline(response.body, meter, fs.createWriteStream(file, {flags: 'wx'}), {signal});
  if (received !== spec.bytes) throw fail('SIZE_MISMATCH', '下载不完整，请重试');
}
