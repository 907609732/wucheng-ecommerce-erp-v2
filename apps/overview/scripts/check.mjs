import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
for(const dir of ['lib','public','scripts','tests'])for(const name of fs.readdirSync(path.join(root,dir))){if(!/\.(mjs|js)$/.test(name))continue;const r=spawnSync(process.execPath,['--check',path.join(root,dir,name)],{encoding:'utf8'});if(r.status){process.stderr.write(r.stderr);process.exit(r.status);}}
const r=spawnSync(process.execPath,['--check',path.join(root,'server.mjs')],{encoding:'utf8'});if(r.status){process.stderr.write(r.stderr);process.exit(r.status);}console.log('全部 JavaScript 语法检查通过');
