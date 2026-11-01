import {fixture} from '../tests/helpers.mjs';
import {createApp} from '../server.mjs';
import path from 'node:path';
const f=fixture(),a=createApp({dataDir:path.join(f.dir,'ui-data'),sources:f.paths});const server=a.app.listen(17891,'127.0.0.1',()=>console.log('隔离验收环境 http://127.0.0.1:17891'));process.on('SIGINT',()=>server.close(()=>{a.store.close();f.close();process.exit(0);}));
