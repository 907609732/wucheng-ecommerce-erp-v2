import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig,databases} from '../config.mjs';
import {disableDataVersioning} from '../../shared/data-version-capture.mjs';
import {restoreDataVersion} from '../../shared/data-version-restore.mjs';
import {assertNoLinks} from './uvcs.mjs';

export function disableOfflineDataVersioning(config){
  const ledgers=[];
  for(const [module,item] of Object.entries(config.modules)){
    assertNoLinks(item.dataDir);
    for(const name of ['.integration-runtime.json','.integration-start.lock']){
      const recordFile=path.join(item.dataDir,name);
      if(!fs.existsSync(recordFile))continue;
      assertNoLinks(recordFile);
      const record=JSON.parse(fs.readFileSync(recordFile,'utf8'));
      for(const pid of [record.pid,record.ownerPid,record.childPid].filter(Number.isSafeInteger)){
        try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')continue;throw e;}
        throw Error('请先停止全部业务模块，再停用版本保护或回退程序');
      }
    }
    const file=path.join(item.dataDir,databases[module]);
    assertNoLinks(file);
    if(fs.existsSync(file))ledgers.push({module,file});
  }
  for(const {file} of ledgers){const db=new DatabaseSync(file);try{disableDataVersioning(db);}finally{db.close();}}
  return {ok:true,modules:ledgers.map(item=>item.module),message:'版本历史保留；停用期间的写入不再逐次保护，重新启用时建立新基线'};
}

export function main(argv){
  const [command,...args]=argv,options={};
  for(let i=0;i<args.length;i+=2){if(!['--config','--event-dir','--target'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('维护参数无效');options[args[i]]=args[i+1];}
  if(command==='restore'&&options['--event-dir']&&options['--target']&&!options['--config'])return restoreDataVersion(path.resolve(options['--event-dir']),path.resolve(options['--target']));
  if(command==='disable'&&options['--config']&&!options['--event-dir']&&!options['--target']){
    const file=path.resolve(options['--config']),config=loadConfig(file);
    const result=disableOfflineDataVersioning(config);
    config.dataVersion={...config.dataVersion,enabled:false};
    const temporary=file+'.data-version.tmp';
    fs.writeFileSync(temporary,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
    fs.renameSync(temporary,file);
    return result;
  }
  throw Error('用法：restore --event-dir 事件目录 --target 新目录；或停止服务后 disable --config 配置文件');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(main(process.argv.slice(2))));
