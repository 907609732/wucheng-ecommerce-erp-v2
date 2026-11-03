import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shared=path.join(root,'shared/ui');
const names=['loading-screen.css','loading-screen.mjs','loading-screen-auto.mjs'];
for(const id of ['purchase','sales','overview']){
  const target=path.join(root,'apps',id,'public');
  for(const name of names)fs.copyFileSync(path.join(shared,name),path.join(target,name));
  fs.copyFileSync(path.join(root,'shared/ui/loading-logo.png'),path.join(target,'loading-logo.png'));
}
console.log('Synchronized loading assets for three browser modules.');
