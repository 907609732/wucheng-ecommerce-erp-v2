import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const targets = ['apps/purchase/public/ui','apps/sales/public/ui','apps/overview/public/ui'];
export function assetNames() {
  return ['tokens.css','base.css','components.css','icons.svg','chart-theme.mjs','period-picker.mjs',
    ...fs.readdirSync(path.join(root,'ui/vendor')).filter(n=>n.endsWith('.css')).sort().map(n=>'vendor/'+n)].sort();
}
function filesIn(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(e=>
    e.isDirectory()?filesIn(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);
}
export function syncUI(check = false) {
  const names = assetNames(), drift = [];
  const total = names.reduce((sum,n)=>sum+fs.statSync(path.join(root,'ui',n)).size,0);
  for (const target of targets) {
    // P7 explicitly retires this one generated asset; never delete unknown files.
    const retired=path.join(root,target,'legacy-aliases.css');
    if(!check&&fs.existsSync(retired))fs.unlinkSync(retired);
    const extra = filesIn(path.join(root,target)).filter(n=>!names.includes(n));
    for (const n of extra) drift.push(`${target}/${n}（非分发文件，请人工检查）`);
    for (const name of names) {
      const source = fs.readFileSync(path.join(root,'ui',name));
      const dest = path.join(root,target,name);
      if (check) {
        if (!fs.existsSync(dest) || !source.equals(fs.readFileSync(dest))) drift.push(`${target}/${name}`);
      } else {
        fs.mkdirSync(path.dirname(dest),{recursive:true});
        fs.writeFileSync(dest,source);
      }
    }
    console.log(`${check?'校验':'同步'} ${target}：${names.length} 个文件，${total} 字节`);
  }
  const hostTokens=path.join(root,'server/public/tokens.css'), tokens=fs.readFileSync(path.join(root,'ui/tokens.css'));
  if(check){if(!fs.existsSync(hostTokens)||!tokens.equals(fs.readFileSync(hostTokens)))drift.push('server/public/tokens.css');}
  else fs.writeFileSync(hostTokens,tokens);
  if (drift.length) {
    console.error('共享 UI 漂移：\n'+drift.join('\n'));
    process.exitCode = 1;
  }
  return drift;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncUI(process.argv.includes('--check'));
