import {app} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.ERP_SOURCE_ROOT,log=process.env.ERP_SOURCE_BOOT_LOG;
const fail=error=>{fs.appendFileSync(log,String(error.stack||error)+'\n');app.exit(1);};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
fs.appendFileSync(log,'source-bootstrap-start\n');
try{app.setAppPath(root);await import(pathToFileURL(path.join(root,'desktop/main.mjs')).href);}catch(error){fail(error);}
