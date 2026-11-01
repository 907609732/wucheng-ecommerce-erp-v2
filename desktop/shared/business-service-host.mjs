import {Worker} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
const modules=new Map();
const allowed=new Set(['purchase','sales','overview']);
// Only the authenticated parent IPC channel can supply a module. Each worker
// has its own environment, SQLite connections, timers and native Node context.
process.on('message',message=>{
 if(message?.type!=='start'||!allowed.has(message.id)||typeof message.requestId!=='string')return;
 const {id,requestId,entry,env,lockFile,lockToken}=message;
 if(!path.isAbsolute(entry)||path.basename(entry)!=='server.mjs'||typeof env!=='object')return;
 if(modules.has(id)){process.send?.({type:'error',requestId,message:'Business module already running'});return;}
 const worker=new Worker(new URL('./business-service-worker.mjs',import.meta.url),{workerData:{entry},env,stdout:true,stderr:true});
 modules.set(id,worker);
 worker.stdout.pipe(process.stdout);worker.stderr.pipe(process.stderr);
 worker.once('online',()=>process.send?.({type:'started',requestId}));
 worker.once('error',error=>process.send?.({type:'error',requestId,message:error.message}));
 worker.once('exit',code=>{
  modules.delete(id);
  // A shared PID remains alive while another worker runs. Remove this worker's
  // own start lock so an independently stopped module can restart safely.
  try{const value=JSON.parse(fs.readFileSync(lockFile,'utf8'));if(value.token===lockToken&&value.childPid===process.pid)fs.unlinkSync(lockFile);}catch{}
  if(process.connected)process.send?.({type:'exit',requestId,code});
  if(!modules.size&&!process.connected)process.exit(0);
 });
});
process.on('disconnect',()=>{if(!modules.size)process.exit(0);});
