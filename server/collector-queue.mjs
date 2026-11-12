import fs from 'node:fs';
import {randomBytes} from 'node:crypto';

const fail=message=>Object.assign(Error(message),{code:'COLLECTOR_QUEUE'});
const timeout=()=>fail('等待采集超时，本次操作尚未开始。请稍后点击继续。');
// The single native helper owns this queue. A submission reservation survives
// helper restarts; a lost response must not permit a second ambiguous export.
export class CollectorQueue {
 constructor(file,{onChange=()=>{},leaseMs=660000}={}){
  this.file=file;this.onChange=onChange;this.leaseMs=leaseMs;this.pending=[];this.active=null;this.lease=null;this.closed=null;
  if(fs.existsSync(file)){
   this.reservation=JSON.parse(fs.readFileSync(file,'utf8'));
   const r=this.reservation;
   if(r?.version!==1||!['sales','overview'].includes(r.owner)||typeof r.key!=='string'||typeof r.account!=='string'||!['reserved','submitted'].includes(r.phase))throw Error('共享采集提交记录无效，请核对已有平台任务');
   if(r.phase==='reserved')this.save(null);
  }
 }
 save(value){
  if(value){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,this.file);}
  else if(fs.existsSync(this.file))fs.unlinkSync(this.file);
  this.reservation=value;
 }
 enqueue(owner,action,fn,{signal,deadline=Date.now()+660000,lease}={}){
  if(this.closed)return Promise.reject(this.closed);
  if(signal?.aborted)return Promise.reject(fail('采集操作已取消'));
  if(deadline<=Date.now())return Promise.reject(timeout());
  return new Promise((resolve,reject)=>{
   const item={owner,action,fn,signal,deadline,lease,resolve,reject};
   item.cancel=()=>{if(this.active===item)return;const index=this.pending.indexOf(item);if(index<0)return;this.pending.splice(index,1);this.clean(item);reject(signal?.aborted?fail('采集操作已取消'):timeout());this.changed();this.pump();};
   item.timer=setTimeout(item.cancel,Math.min(deadline-Date.now(),2147483647));item.timer.unref?.();signal?.addEventListener('abort',item.cancel,{once:true});
   this.pending.push(item);this.changed();this.pump();
  });
 }
 clean(item){clearTimeout(item.timer);item.signal?.removeEventListener('abort',item.cancel);}
 changed(){this.onChange();}
 arm(){clearTimeout(this.leaseTimer);if(!this.lease||this.closed)return;this.leaseTimer=setTimeout(()=>{if(this.active){this.arm();return;}this.abandon();this.pump();},this.leaseMs);this.leaseTimer.unref?.();}
 abandon(){if(!this.lease)return;clearTimeout(this.leaseTimer);this.lease=null;if(this.reservation?.phase==='reserved')this.save(null);this.changed();}
 acquire(owner,{key,account,recovering=false}){
  if(typeof key!=='string'||key.length<1||key.length>250||typeof account!=='string'||account.length<1||account.length>200)throw fail('提交占用信息无效');
  const r=this.reservation;
  if(r&&(r.owner!==owner||r.key!==key||r.account!==account))throw fail('有一项平台下载申请尚待核对，请先继续原任务，避免重复申请');
  if(this.lease)throw fail('已有提交占用，请先继续原任务');
  this.save(r||{version:1,owner,key,account,phase:recovering?'submitted':'reserved'});
  this.lease={owner,token:randomBytes(24).toString('hex')};this.arm();this.changed();return this.lease.token;
 }
 verify(owner,token){if(!this.lease||this.lease.owner!==owner||this.lease.token!==token)throw fail('提交占用已失效，请继续原任务后再操作');}
 submitted(owner,token){this.verify(owner,token);this.save({...this.reservation,phase:'submitted'});}
 settle(owner,{key,account,proof}){
  if(!['task-bound','download-ready'].includes(proof)||typeof key!=='string'||typeof account!=='string')throw fail('平台任务恢复信息无效');
  const r=this.reservation;if(!r||r.owner!==owner||r.key!==key||r.account!==account)return false;
  // The business record already contains the unique task binding (or saved
  // direct download). Recover a crash between saving it and release RPC.
  this.save(null);this.lease=null;clearTimeout(this.leaseTimer);this.changed();return true;
 }
 release(owner,token,{unresolved=false}={}){if(!this.lease)return;this.verify(owner,token);if(!unresolved||this.reservation?.phase==='reserved')this.save(null);this.lease=null;clearTimeout(this.leaseTimer);this.changed();}
 cancelOwner(owner){for(const item of [...this.pending])if(item.owner===owner){this.pending.splice(this.pending.indexOf(item),1);this.clean(item);item.reject(fail('采集连接已断开，本次排队操作已取消'));}this.changed();}
 state(owner){const at=this.pending.findIndex(i=>i.owner===owner);if(at>=0){const other=this.active?.owner||this.lease?.owner;return {state:'queued',position:at+1,message:other&&other!==owner?`正在等待${other==='sales'?'销售':'经营总览'}采集完成，随后自动继续。`:'采集任务正在排队，稍后自动继续。'};}return {state:this.active?.owner===owner?'running':'idle',position:0,message:''};}
 pump(){
  if(this.active||this.closed)return;
  const index=this.pending.findIndex(i=>!this.lease||i.action==='settleSubmission'||(i.owner===this.lease.owner&&(i.lease===this.lease.token||i.action==='disconnect')));
  if(index<0)return;
  const item=this.pending.splice(index,1)[0];
  if(item.signal?.aborted||item.deadline<=Date.now()){this.clean(item);item.reject(item.signal?.aborted?fail('采集操作已取消'):timeout());this.pump();return;}
  this.active=item;this.clean(item);this.arm();this.changed();
  this.running=(async()=>{
   try{
    if(item.lease&&!(item.action==='releaseSubmission'&&!this.lease))this.verify(item.owner,item.lease);
    const value=await item.fn();
    // An acquire response lost to the caller cannot leave an orphan lease.
    if(item.signal?.aborted&&item.action==='acquireSubmission')this.abandon();
    item.resolve(value);
   }catch(error){item.reject(error);}
   finally{this.active=null;this.running=null;this.arm();this.changed();this.pump();}
  })();
 }
 close(error=fail('采集助手正在关闭')){this.closed=error;clearTimeout(this.leaseTimer);for(const item of this.pending.splice(0)){this.clean(item);item.reject(error);}this.changed();}
 async drain(){await this.running;}
}
