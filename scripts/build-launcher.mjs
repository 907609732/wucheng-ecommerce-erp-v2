import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd();fs.mkdirSync('dist',{recursive:true});
const stage=fs.mkdtempSync(path.resolve('dist/launcher-app-'));
const files=['desktop/launcher','desktop/modules','desktop/local-desks.mjs','desktop/extension-preload.cjs',
  'desktop/shared/service-manager.mjs','desktop/shared/user-data-path.mjs','desktop/shared/ai-interface.mjs',
  'desktop/extensions/lingtu-desks','desktop/updater.mjs','desktop/mcp-stdio-entry.mjs','desktop/mcp-server.mjs','desktop/assets/lingtu-icon.png'];
for(const relative of files)fs.cpSync(path.join(root,relative),path.join(stage,relative),{recursive:true});
// A launcher contains no cloud business page, core/, config.json, ledger or credentials.
const wanted=['yauzl','semver','electron-updater','@modelcontextprotocol/server','zod'];
const dependencies=Object.fromEntries(wanted.map(name=>[name,JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8')).version]));
const pkg={name:'wucheng-ecommerce-erp-v2',version:'0.8.0',description:'灵兔按需扩展启动台',author:'五成电子商务集团',private:true,type:'module',main:'desktop/launcher/main.mjs',dependencies};
fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(pkg,null,2));
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
lock.name=pkg.name;lock.version=pkg.version;lock.packages['']={name:pkg.name,version:pkg.version,dependencies};
fs.writeFileSync(path.join(stage,'package-lock.json'),JSON.stringify(lock,null,2));
const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const install=spawnSync(process.execPath,[npmCli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit',windowsHide:true});
if(install.status!==0)throw Error('Launcher dependency installation failed');
const config=path.join(root,'build/launcher-builder.config.cjs');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--projectDir',stage,'--config',config,'--win',...(process.argv.includes('--dir')?['--dir']:['nsis','portable']),'--publish','never'],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.status!==0)throw Error('Launcher build failed');
console.log(JSON.stringify({stage,output:path.join(root,'dist/launcher-release')}));
