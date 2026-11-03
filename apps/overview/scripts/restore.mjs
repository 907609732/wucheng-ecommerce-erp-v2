import fs from 'node:fs';
import path from 'node:path';
import {restoreBackup} from '../lib/files.mjs';
if(!process.argv[2])throw Error('用法：npm.cmd run restore -- "备份ZIP绝对路径"');
console.log(await restoreBackup(fs.readFileSync(path.resolve(process.argv[2])),path.resolve(import.meta.dirname,'../data/restored')));
