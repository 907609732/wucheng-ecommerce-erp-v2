import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {digest, safeRelative} from '../desktop/modules/package-format.mjs';

const {values} = parseArgs({options: {
  id: {type: 'string'}, source: {type: 'string'}, output: {type: 'string'},
  tag: {type: 'string'}, 'node-exe': {type: 'string'}, version: {type: 'string'}, entry: {type:'string'}
}});
const {id, source, tag} = values;
if (!['purchase', 'sales', 'overview', 'node-runtime', 'browser-runtime', 'warehouse', 'exporter'].includes(id) || !source || !tag || !/^[\w.-]+$/.test(tag)) {
  throw Error('Usage: node scripts/build-module-pack.mjs --id purchase|sales|overview|node-runtime --source ABSOLUTE_DIRECTORY --output DIRECTORY --tag RELEASE_TAG');
}
const output = path.resolve(values.output || 'dist/modules');
const workspace = path.resolve(source);
fs.mkdirSync(output, {recursive: true});
const stage = fs.mkdtempSync(path.join(output, '.stage-' + id + '-'));
const packageNames = {purchase: 'purchase-desk', sales: 'wucheng-sales-desk', overview: 'lingtu-business-overview'};
let version, entry, kind, dependencies;
try {
  if (['browser-runtime','warehouse','exporter'].includes(id)) {
    if (!values.version || !values.entry) throw Error('Prebuilt runtime packages require --version and --entry');
    version = values.version; entry = safeRelative(values.entry);
    kind = id === 'browser-runtime' ? 'runtime' : 'electron';
    dependencies = id === 'warehouse' ? [{id:'browser-runtime',range:'1.61.0'}] : [];
    if (!fs.existsSync(path.join(workspace, entry))) throw Error('Prebuilt entry is missing');
    const updateToken = path.join(workspace, 'resources', 'update-token.txt');
    if (fs.existsSync(updateToken) && fs.readFileSync(updateToken,'utf8').trim()) throw Error('A public package must not contain an update token');
    fs.cpSync(workspace, stage, {recursive:true, filter:file => {
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('Prebuilt package contains a link');
      if (/\.(?:sqlite(?:-wal|-shm)?|db|pfx|pem|key)$/i.test(file)) throw Error('Prebuilt package contains private data');
      return true;
    }});
    // NSIS detects running launchers by executable name. Give the background
    // cloud process its own image name so a launcher upgrade cannot terminate it.
    if(id==='warehouse'&&entry!=='LingtuWarehouseModule.exe'){
      fs.renameSync(path.join(stage,entry),path.join(stage,'LingtuWarehouseModule.exe'));
      entry='LingtuWarehouseModule.exe';
    }
  } else if (id === 'node-runtime') {
    const exe = values['node-exe'] || path.join(workspace, 'node.exe');
    const result = spawnSync(exe, ['--version'], {encoding: 'utf8', windowsHide: true});
    if (result.status !== 0 || !/^v24\./.test(result.stdout.trim())) throw Error('Require Node.js 24 runtime');
    version = result.stdout.trim().slice(1); entry = 'node.exe'; kind = 'runtime'; dependencies = [];
    fs.copyFileSync(exe, path.join(stage, 'node.exe'));
    const license = path.join(workspace, 'LICENSE');
    if (!fs.existsSync(license)) throw Error('Node runtime LICENSE is required');
    fs.copyFileSync(license, path.join(stage, 'LICENSE'));
  } else {
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    if (manifest.name !== packageNames[id]) throw Error('Unexpected workspace package identity');
    version = manifest.version; entry = 'server.mjs'; kind = 'service';
    dependencies = [{id: 'node-runtime', range: '>=24.18.0 <25'}];
    const entries = ['package.json', 'package-lock.json', 'server.mjs', 'lib', 'public'];
    // Source allowlist only: no data/, originals, attachments, config or credentials.
    for (const name of entries) fs.cpSync(path.join(workspace, name), path.join(stage, name), {
      recursive: true, dereference: false, filter: file => {
        if (fs.lstatSync(file).isSymbolicLink()) throw Error('Source symlinks require review');
        const relative = path.relative(workspace, file).replaceAll('\\', '/');
        if (/(^|\/)(?:\.env[^/]*|data|private|backups?|originals|attachments)(\/|$)|\.(?:sqlite|db|pem|key|pfx|log)$/i.test(relative)) throw Error('Private data in source allowlist: ' + relative);
        return true;
      }
    });
    for (const name of ['licenses', 'LICENSE']) {
      if (fs.existsSync(path.join(workspace, name))) fs.cpSync(path.join(workspace, name), path.join(stage, name), {recursive: true});
    }
    if(id==='sales'){
      const config=path.join(stage,'lib','config.mjs'),text=fs.readFileSync(config,'utf8');
      const split=text.indexOf('export const KINDS');
      if(split<0||!text.startsWith('export const SHOPS'))throw Error('Sales defaults require review before public packaging');
      fs.writeFileSync(config,"export const SHOPS = [{id:'offline',platform:'线下',name:'线下销售',receipts:'手工登记',manual:true},{id:'dropship',platform:'代发',name:'供货代发',receipts:'手工登记',manual:true}];\n"+text.slice(split));
    }
    if(id==='purchase'){
      const mobile=path.join(stage,'public','mobile.html');
      fs.writeFileSync(mobile,fs.readFileSync(mobile,'utf8').replace(/<button type="button" data-username="[^"]*">[^<]*<\/button>/g,''));
      const models=path.join(process.env.LOCALAPPDATA,'PurchaseDesk','ocr-models');
      const target=path.join(stage,'resources','ocr');fs.mkdirSync(target,{recursive:true});
      for(const language of ['chi_sim','eng']){
        const file=path.join(models,language+'.traineddata');
        if(!fs.existsSync(file))throw Error('Build requires the public OCR model: '+language);
        fs.copyFileSync(file,path.join(target,language+'.traineddata'));
      }
      const license=await fetch('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/LICENSE',{signal:AbortSignal.timeout(30000)});
      if(!license.ok)throw Error('Cannot obtain OCR model redistribution license');
      fs.writeFileSync(path.join(target,'LICENSE'),await license.text());
    }
    // Production dependencies are resolved from the lockfile in clean staging,
    // never copied from a developer's node_modules.
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw Error('System npm CLI is required to build packages');
    const install = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: stage, stdio: 'inherit', windowsHide: true
    });
    if (install.status !== 0) throw Error('Production dependency install failed');
  }
  const files = [];
  const walk = (directory, prefix = '') => {
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      const relative = prefix + item.name, file = path.join(directory, item.name);
      // npm's command shims are unnecessary when starting the service directly.
      if (item.name === '.bin') continue;
      if (item.isSymbolicLink()) throw Error('Package contains a symbolic link: ' + relative);
      if (item.isDirectory()) walk(file, relative + '/');
      else { safeRelative(relative); files.push({relative, file, size: fs.statSync(file).size}); }
    }
  };
  walk(stage); files.sort((a, b) => a.relative.localeCompare(b.relative));
  const archive = `${id}-${version}-win32-x64.zip`, archivePath = path.join(output, archive);
  const zip = new yazl.ZipFile();
  for (const file of files) zip.addFile(file.file, file.relative);
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(archivePath));
  const spec = {id, version, hostRange: '>=0.8.0 <1.0.0', platform: 'win32', arch: 'x64', kind, entry, dependencies,
    archive, bytes: fs.statSync(archivePath).size, unpackedBytes: files.reduce((sum, file) => sum + file.size, 0),
    sha256: await digest(archivePath),
    url: `https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/${tag}/${archive}`};
  fs.writeFileSync(path.join(output, id + '.descriptor.json'), JSON.stringify(spec, null, 2));
  console.log(JSON.stringify({id, version, archive, bytes: spec.bytes, files: files.length}));
} finally {
  if (!stage.startsWith(output + path.sep + '.stage-')) throw Error('Invalid build staging path');
  fs.rmSync(stage, {recursive: true, force: true});
}
