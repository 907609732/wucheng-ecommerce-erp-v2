import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {id,now,hash,fail} from './util.mjs';
import {CainiaoBrowser,humanError} from './cainiao-browser.mjs';
import {REPORTS,monthRange,monthDates,chinaMonth,archiveFile,inspectBill,reconcile,resolveArchive} from './cainiao-files.mjs';
export function initCainiao(s){s.db.exec(`
 CREATE TABLE IF NOT EXISTS cainiao_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cainiao_files(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,account_key TEXT NOT NULL,period TEXT NOT NULL,report TEXT NOT NULL,path TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS cainiao_file_hash ON cainiao_files(account_key,period,report,sha256);`);}
const done=i=>['completed','empty','unavailable'].includes(i.status);
export function taskMatches(t,job,item){
 const dates=monthDates(item.month),range=dates.from.replace(/-/g,'')+'_'+dates.to.replace(/-/g,'');
 if(t.account!==job.account)return false;
 if(item.type==='warehouse')return /仓储/.test(t.name)&&t.name.includes(item.month.replace('-',''))&&(!t.basis||t.basis==='-'||t.basis==='业务时间');
 // Cainiao currently labels fee exports as "交易明细账单" too. Only a new ID
 // after our persisted submission baseline is admissible; file headers verify its type.
 return t.basis==='业务时间'&&t.name.includes(range)&&/交易明细账单|费用项/.test(t.name);
}
export function findNewTask(tasks,job,item){const list=tasks.filter(t=>taskMatches(t,job,item)&&!item.baselineIds.includes(t.id));if(list.length>1)throw fail('有多个新任务符合条件，请在平台核对后再继续，程序不会猜测文件');return list[0]||null;}
export class CainiaoDownloads{
 constructor(s,{browser,pollMs=15000,waitMs=600000}={}){
  initCainiao(s);this.s=s;this.browser=browser||new CainiaoBrowser(s.dir);this.active=null;this.pollMs=pollMs;this.waitMs=waitMs;this.cancelled=new Set();this.lockPath=path.join(s.dir,'.cainiao-run.lock');
  if(!this.liveLock())for(const job of this.list()){if(job.status==='running'){job.status='paused';job.message='应用重启，点击继续核对平台任务';for(const item of job.items)if(['querying','submitting','downloading','waiting'].includes(item.status))item.status=item.submittedAt?'waiting':'pending';this.save(job);}}
 }
 liveLock(){if(!fs.existsSync(this.lockPath))return null;let lock;try{lock=JSON.parse(fs.readFileSync(this.lockPath,'utf8'));}catch{return {jobId:'unknown',invalid:true};}if(!Number.isInteger(lock.pid)||!lock.jobId)return {jobId:'unknown',invalid:true};try{process.kill(lock.pid,0);return lock;}catch(e){if(e.code==='ESRCH')return null;return lock;}}
 acquireLock(job){if(this.liveLock())throw fail('已有云仓下载程序运行中',409);if(fs.existsSync(this.lockPath))fs.unlinkSync(this.lockPath);fs.writeFileSync(this.lockPath,JSON.stringify({pid:process.pid,jobId:job.id,createdAt:now()}),{flag:'wx'});}
 releaseLock(job){if(!fs.existsSync(this.lockPath))return;const lock=JSON.parse(fs.readFileSync(this.lockPath,'utf8'));if(lock.pid===process.pid&&lock.jobId===job.id)fs.unlinkSync(this.lockPath);}
 list(){return this.s.all('SELECT payload FROM cainiao_jobs ORDER BY created_at DESC').map(r=>JSON.parse(r.payload));}
 get(jid){const r=this.s.get('SELECT payload FROM cainiao_jobs WHERE id=?',jid);if(!r)throw fail('下载任务不存在',404);return JSON.parse(r.payload);}
 save(job){job.updatedAt=now();this.s.run('INSERT INTO cainiao_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',job.id,JSON.stringify(job),job.createdAt);this.writeManifest(job);}
 writeManifest(job){for(const month of job.months){const dir=path.join(this.s.dir,'downloads','cainiao',job.accountKey,month,job.id);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'manifest.json');fs.writeFileSync(file+'.part',JSON.stringify(this.manifest(job,month),null,2));fs.renameSync(file+'.part',file);}}
 manifest(job,month){return {version:1,account:job.account,month,basis:'业务时间',jobId:job.id,status:job.status,updatedAt:job.updatedAt,interim:job.interimMonths.includes(month),items:job.items.filter(i=>i.month===month),files:this.files(job).filter(f=>f.period===month)};}
 files(job){const ids=[...new Set(job.items.flatMap(i=>i.fileIds||[]))];return ids.map(fid=>this.s.get('SELECT * FROM cainiao_files WHERE id=?',fid)).filter(Boolean).map(f=>({...f,details:JSON.parse(f.payload),payload:undefined,url:'/api/cainiao/files/'+f.id}));}
 multiMonthReady(){return this.list().some(j=>j.months.includes('2026-09')&&j.items.filter(i=>i.month==='2026-09').length===3&&j.items.filter(i=>i.month==='2026-09').every(done)&&j.items.filter(i=>i.month==='2026-09'&&i.type!=='warehouse').every(i=>i.status==='completed'&&i.verification?.verified));}
 info(){return {...this.browser.status(),activeJobId:this.active?.id||this.liveLock()?.jobId||null,multiMonthReady:this.multiMonthReady()};}
 connect(){if(this.active)throw fail('下载运行中，请先暂停任务再重新连接',409);if(this.browser.status().status==='connecting')return;void this.browser.connect();}
 async disconnect(){if(this.active)throw fail('请先取消运行中的任务',409);await this.browser.disconnect();}
 validateStart(input){
  if(this.active||this.liveLock())throw fail('已有下载任务运行中或运行锁需要核对',409);const conn=this.browser.status();if(conn.status!=='connected')throw fail('请先连接已登录的 Chrome',409);
  if(input.account!==conn.account)throw fail('当前账户已变化，请重新确认页面账户',409);
  const months=monthRange(input.from,input.to||input.from);if(months.length>1&&!this.multiMonthReady())throw fail('先完成 2026 年 9 月真实下载核验，再使用多月下载',409);
  return {account:conn.account,months};
 }
 start(input){
  const {account,months}=this.validateStart(input);
  const job={id:id(),account,accountKey:hash(account).slice(0,16),months,interimMonths:months.filter(m=>m===chinaMonth()),createdAt:now(),status:'pending',force:input.force===true,message:'准备查询账单',items:months.flatMap(month=>Object.keys(REPORTS).map(type=>({month,type,status:'pending',fileIds:[]})))};
  this.save(job);this.launch(job);return this.get(job.id);
 }
 validateResume(jid){if(this.active||this.liveLock())throw fail('已有下载任务运行中',409);const job=this.get(jid);if(this.browser.status().status!=='connected'||this.browser.status().account!==job.account)throw fail('请连接此任务对应的菜鸟账户',409);return job;}
 resume(jid){const job=this.validateResume(jid);if(job.items.every(done))return job;this.launch(job);return this.get(jid);}
 cancel(jid){const job=this.get(jid);if(this.active?.id===jid){this.cancelled.add(jid);job.message='正在停止本地后续操作，平台已生成任务保留';}else{if(this.liveLock()?.jobId===jid)throw fail('该任务由另一个系统进程运行，请在其页面停止',409);job.status='cancelled';job.message='已停止，原件及平台任务保留，可继续';}this.save(job);return job;}
 launch(job){this.acquireLock(job);this.cancelled.delete(job.id);job.status='running';this.active=job;this.save(job);this.running=this.run(job).catch(e=>{job.status='paused';job.message=humanError(e);this.save(job);}).finally(()=>{this.releaseLock(job);this.active=null;});}
 check(job){if(this.cancelled.has(job.id))throw Object.assign(Error('已停止，已下载原件和平台任务保留'),{cancelled:true});}
 reusable(job,item){for(const prior of this.list()){if(prior.id===job.id||prior.account!==job.account)continue;const old=prior.items.find(i=>i.month===item.month&&i.type===item.type&&i.status==='completed');if(!old?.fileIds?.length)continue;const valid=old.fileIds.every(fid=>{const f=this.s.get('SELECT * FROM cainiao_files WHERE id=?',fid);return f&&fs.existsSync(resolveArchive(this.s.dir,f.path))&&hash(fs.readFileSync(resolveArchive(this.s.dir,f.path)))===f.sha256;});if(valid)return old;}return null;}
 async run(job){
  for(const item of job.items){
   if(done(item))continue;
   try{
    this.check(job);job.message=item.month+' · '+REPORTS[item.type];item.error='';this.save(job);
    if(!job.force&&!item.submittedAt){const old=this.reusable(job,item);if(old){Object.assign(item,old,{reused:true});this.save(job);continue;}}
    const args={account:job.account,month:item.month,type:item.type,...monthDates(item.month)};
    if(item.downloadReady&&(!item.target||!fs.existsSync(item.target)))delete item.downloadReady;
    if(!item.submittedAt){
     item.status='querying';this.save(job);item.expected=await this.browser.run('prepare',args);this.check(job);
     if(item.expected.count===0&&item.type!=='warehouse'){item.status='empty';item.reason='平台查询明确返回 0 条记录';this.save(job);continue;}
     const baseline=await this.browser.run('tasks',{account:job.account});this.check(job);
     item.baselineIds=baseline.map(t=>t.id);item.submittedAt=now();item.status='submitting';item.target=path.join(this.browser.dir,id()+'.part');this.save(job);
     const result=await this.browser.run('submit',{...args,expected:item.expected,target:item.target});
     if(result.empty||result.unavailable){item.status=result.empty?'empty':'unavailable';item.reason=result.reason;this.save(job);continue;}
     if(result.direct){item.filename=result.filename;item.downloadReady=true;this.save(job);}
    }
    this.check(job);
    if(!item.downloadReady){
     item.status='waiting';this.save(job);const deadline=Date.now()+this.waitMs;
     while(true){
      this.check(job);const tasks=await this.browser.run('tasks',{account:job.account});this.check(job);
      if(!item.remoteTask){item.remoteTask=findNewTask(tasks,job,item);if(item.remoteTask)this.save(job);}
      const remote=item.remoteTask?tasks.find(t=>t.id===item.remoteTask.id):null;
      if(remote){if(!taskMatches(remote,job,item)||remote.name!==item.remoteTask.name)throw Error('平台任务信息与记录不一致');item.remoteTask=remote;this.save(job);if(/失败|取消/.test(remote.status))throw Error('平台任务'+remote.status+'，请在菜鸟核对');if(remote.status==='已完成')break;}
      if(Date.now()>=deadline){item.status='waiting';item.error=item.remoteTask?'等待平台生成，稍后可继续':'尚未找到本次任务，请核对平台后继续；不会自动重复提交';break;}
      await new Promise(resolve=>{this.wake=resolve;const timer=setTimeout(resolve,this.pollMs);this.timer=timer;});this.wake=null;
     }
     if(!item.remoteTask){job.status='paused';job.message=item.error;this.save(job);return;}
     if(item.remoteTask.status!=='已完成'){this.save(job);continue;}
     this.check(job);item.status='downloading';item.target=path.join(this.browser.dir,id()+'.part');this.save(job);
     const file=await this.browser.run('download',{account:job.account,task:item.remoteTask,target:item.target});item.filename=file.filename;item.downloadReady=true;this.save(job);
    }
    // Keep successful downloads even when cancellation arrived while the browser was saving.
    const inspection=await inspectBill(fs.readFileSync(item.target),item.filename),verification=reconcile(item.type,inspection,item.expected);
    const archived=archiveFile(this.s,job,item,item.target,item.filename,inspection,verification);item.fileIds=[archived.id];item.verification=verification;item.reused=archived.reused;item.status=verification.verified?'completed':'needs_review';item.error=verification.verified?'':verification.reason;
    fs.unlinkSync(item.target);delete item.target;delete item.downloadReady;this.save(job);this.check(job);
   }catch(e){
    item.error=humanError(e);
    if(e.cancelled){if(!done(item))item.status=item.submittedAt?'waiting':'pending';job.status='cancelled';job.message=e.message;this.save(job);return;}
    if(/NEEDS_LOGIN|ACCOUNT_CHANGED|NEEDS_ACTION|connect|extension|closed|timeout|timed out|disconnected/i.test(e.message)){if(!done(item))item.status=item.submittedAt?'waiting':'pending';job.status='paused';job.message=humanError(e);this.save(job);return;}
    item.status=item.submittedAt&&!item.remoteTask?'uncertain':'failed';this.save(job);
    if(item.status==='uncertain'){job.status='paused';job.message='提交结果待核对，继续时先查询平台任务，避免重复申请';this.save(job);return;}
   }
  }
  job.status=job.items.every(done)?'completed':job.items.some(i=>done(i)||i.fileIds.length)?'partial':'paused';job.message=job.status==='completed'?'下载完成，原件已保存；尚未入账':'部分项目仍待处理，点击继续补齐';this.save(job);
 }
 async close(){if(this.active)this.cancelled.add(this.active.id);if(this.timer)clearTimeout(this.timer);this.wake?.();await this.browser.disconnect();await this.running;}
}
export function registerCainiao(app,s,options={}){
 const manager=new CainiaoDownloads(s,options);
 app.get('/api/cainiao/connection',(_q,r)=>r.json(manager.info()));
 app.post('/api/cainiao/connection',(q,r)=>{if(q.body.action==='disconnect')return manager.disconnect().then(()=>r.json(manager.info()));if(q.body.action!=='connect')throw fail('连接操作无效');manager.connect();r.status(202).json(manager.info());});
 app.post('/api/cainiao/authorization',async(q,r)=>{if(manager.active||manager.liveLock())throw fail('请先停止下载，再修改浏览器授权',409);if(!manager.browser.rememberAuthorization)throw fail('当前浏览器不支持记住授权',409);if(q.body.action==='save'){if(q.body.consent!==true)throw fail('请确认允许本机程序以后自动连接此 Chrome');await manager.browser.rememberAuthorization(q.body.token);}else if(q.body.action==='forget')await manager.browser.forgetAuthorization();else throw fail('授权操作无效');r.json({saved:manager.browser.status().authorizationSaved===true});});
 app.get('/api/cainiao/download-jobs',(_q,r)=>r.json(manager.list().map(j=>({...j,files:manager.files(j)}))));
 app.post('/api/cainiao/download-jobs',(q,r)=>r.status(202).json(manager.start(q.body)));
 app.get('/api/cainiao/download-jobs/:id',(q,r)=>{const j=manager.get(q.params.id);r.json({...j,files:manager.files(j)});});
 app.post('/api/cainiao/download-jobs/:id/resume',(q,r)=>r.status(202).json(manager.resume(q.params.id)));
 app.post('/api/cainiao/download-jobs/:id/cancel',(q,r)=>{const j=manager.cancel(q.params.id);manager.wake?.();r.json(j);});
 app.post('/api/cainiao/download-jobs/:id/open-folder',(q,r)=>{const j=manager.get(q.params.id),dir=path.join(s.dir,'downloads','cainiao',j.accountKey,j.months[0],j.id);if(process.platform!=='win32')throw fail('此操作仅支持 Windows');if(!fs.existsSync(dir))throw fail('归档目录不存在');const p=spawn('explorer.exe',[dir],{windowsHide:true,stdio:'ignore'});p.on('error',()=>{});p.unref();r.json({ok:true,path:dir});});
 app.get('/api/cainiao/files/:id',(q,r)=>{const f=s.get('SELECT * FROM cainiao_files WHERE id=?',q.params.id);if(!f)throw fail('原件不存在',404);const file=resolveArchive(s.dir,f.path);if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==f.sha256)throw fail('原件缺失或校验失败，请重新下载',409);r.download(file,f.filename);});
 return manager;
}
