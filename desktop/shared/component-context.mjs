import fs from 'node:fs';
import path from 'node:path';

// Only the packaged dispatcher supplies these values. Business entry points
// still validate the complete contract before resolving a component resource.
export function readComponentContext(expectedId, env = process.env) {
  const keys = ['LINGTU_COMPONENT_ID', 'LINGTU_COMPONENT_APP_ROOT', 'LINGTU_COMPONENT_RESOURCES_DIR', 'LINGTU_COMPONENT_VERSION'];
  if (!keys.some(key => env[key] !== undefined)) return null;
  const invalid = () => Object.assign(new Error('共享运行环境的组件配置无效，已停止启动'), {code: 'COMPONENT_CONTEXT_INVALID'});
  if (!['warehouse', 'exporter'].includes(expectedId) || keys.some(key => typeof env[key] !== 'string' || !env[key]) || env.LINGTU_COMPONENT_ID !== expectedId) throw invalid();
  const appRoot = env.LINGTU_COMPONENT_APP_ROOT;
  const resourcesDir = env.LINGTU_COMPONENT_RESOURCES_DIR;
  if (!path.isAbsolute(appRoot) || !path.isAbsolute(resourcesDir) || path.normalize(appRoot) !== appRoot || path.normalize(resourcesDir) !== resourcesDir || path.basename(appRoot) !== 'app.asar' || path.basename(resourcesDir) !== 'resources' || path.dirname(appRoot) !== resourcesDir || path.basename(path.dirname(resourcesDir)) !== 'runtime') throw invalid();
  const version = env.LINGTU_COMPONENT_VERSION;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw invalid();
  // Electron's patched fs describes an ASAR as a virtual directory. Use its
  // native filesystem for the physical-file check; plain Node uses normal fs.
  const physicalFs = process.versions.electron ? process.getBuiltinModule('original-fs') : fs;
  try { if (!physicalFs.statSync(appRoot).isFile()) throw invalid(); } catch { throw invalid(); }
  // Node-mode MCP bridges have no ASAR filesystem patch. The dispatcher has
  // already verified their context; the Electron business main verifies again.
  if (process.type === 'browser') {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')); } catch { throw invalid(); }
    const main = expectedId === 'warehouse' ? 'desktop/main.mjs' : 'out/main/index.js';
    if (manifest.version !== version || manifest.main !== main) throw invalid();
  }
  return Object.freeze({id: expectedId, appRoot, resourcesDir, version, launchArgs: Object.freeze(['--agent-component=' + expectedId])});
}
