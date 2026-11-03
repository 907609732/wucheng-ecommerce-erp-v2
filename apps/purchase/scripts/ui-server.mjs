import path from 'node:path';
import {createApp} from '../server.mjs';
const {app,store}=createApp({dataDir:path.resolve('.tmp/ui-test-data')});
const server=app.listen(17968,'127.0.0.1',()=>console.log('UI TEST http://127.0.0.1:17968'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
