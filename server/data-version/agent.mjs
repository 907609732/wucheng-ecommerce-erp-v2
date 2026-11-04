import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadConfig} from '../config.mjs';
import {createDataVersionWorker} from './worker.mjs';

/** Runs with the logged-in Windows user's UVCS identity; never copies credentials. */
export async function createUploadAgent({configFile,intervalMs=5000,workerFactory=createDataVersionWorker}){
  const config=loadConfig(configFile);
  if(!config.dataVersion?.enabled||config.dataVersion.uploadMode!=='user-agent')throw Error('当前配置未启用用户代理上传');
  if(!Number.isInteger(intervalMs)||intervalMs<50)throw Error('上传轮询间隔无效');
  const dir=config.dataVersion.dir;
  fs.mkdirSync(dir,{recursive:true});
  const key=createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0,24);
  const endpoint=process.platform==='win32'?'\\\\.\\pipe\\wucheng-data-uploader-'+key:path.join(os.tmpdir(),'wucheng-data-uploader-'+key+'.sock');
  const lock=net.createServer(socket=>socket.destroy());
  try{await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen(endpoint,resolve);});}
  catch(e){if(e.code==='EADDRINUSE')throw Error('数据上传代理已在运行');throw e;}
  let worker;
  try{worker=workerFactory({config});}catch(e){await new Promise(r=>lock.close(r));throw e;}
  const record=path.join(dir,'user-agent-runtime.json');
  let timer,pending,stopped=false,started=false;
  const upload=()=>{
    if(stopped||pending)return pending;
    pending=worker.tick().catch(()=>{}).finally(()=>{pending=null;});
    return pending;
  };
  return {
    async start(){
      if(started||stopped)return;
      started=true;
      fs.writeFileSync(record,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),identity:'current-user'}),{mode:0o600});
      await upload();
      if(!stopped)timer=setInterval(upload,intervalMs);
    },
    async stop(){
      if(stopped)return;
      stopped=true;clearInterval(timer);
      await pending;
      try{await worker.close();}finally{
        fs.rmSync(record,{force:true});
        await new Promise(r=>lock.close(r));
      }
    },
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('用法：node server/data-version/agent.mjs --config 配置文件');
  const agent=await createUploadAgent({configFile:path.resolve(process.argv[3])});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void agent.stop().then(()=>process.exit(0));});
  await agent.start();
}
