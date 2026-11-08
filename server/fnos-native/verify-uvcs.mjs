import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {validateConfig} from '../config.mjs';
import {assertNoLinks} from '../data-version/uvcs.mjs';
import {withNativeLifecycleLock} from './configure.mjs';
import {assertNativeUvcsPrepared,ownedPath,fingerprint,nativeCm,matchingRegistration,repositoryKey,uvcsError,resolveNativeCmPath} from './uvcs-registration.mjs';

function stopped(c){
 const records=new Set(['native-supervisor.json','web-runtime.json','.integration-runtime.json','.integration-start.lock','.web-collector.json']);
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.name==='diagnostics')continue;const file=path.join(dir,entry.name);assertNoLinks(file);
  if(entry.isDirectory())walk(file);else if(records.has(entry.name)){
   ownedPath(file);let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw uvcsError('UVCS_SERVICE_UNCONFIRMED');}
   const pids=[value.pid,value.childPid??value.ownerPid].filter(v=>v!==null&&v!==undefined);
   if(!pids.length)throw uvcsError('UVCS_SERVICE_UNCONFIRMED');
   for(const pid of pids){if(!Number.isSafeInteger(pid)||pid<1)throw uvcsError('UVCS_SERVICE_UNCONFIRMED');try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')continue;throw uvcsError('UVCS_SERVICE_UNCONFIRMED');}throw uvcsError('UVCS_SERVICE_RUNNING');}
  }
 }};walk(c.stateDir);for(const m of Object.values(c.modules))walk(m.dataDir);
 const lease=path.join(c.dataVersion.workspace,'.lingtu-data-version-staging','command-lease.json');assertNoLinks(lease);
 if(fs.existsSync(lease))throw uvcsError('UVCS_COMMAND_LEASE_UNVERIFIED');
}
function queueRows(c){
 const file=path.join(c.dataVersion.dir,'queue.sqlite');ownedPath(file);
 for(const suffix of ['-wal','-shm','-journal']){assertNoLinks(file+suffix);if(fs.existsSync(file+suffix))ownedPath(file+suffix);}
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
  const rows=db.prepare('SELECT * FROM data_version_queue ORDER BY id').all();
  if(rows.some(r=>r.status!=='submitted'))throw uvcsError('UVCS_QUEUE_NOT_SUBMITTED');
  if(rows.some(r=>typeof r.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(r.id)||!/^cs:\d+$/.test(r.changeset||'')))throw uvcsError('UVCS_EVENT_INVALID');
  return rows;
 }finally{db.close();}
}
function protectedState(c,file,deadline=Infinity){
 return {config:fs.readFileSync(file).toString('base64'),home:fingerprint(c.native.home,{owned:true,deadline}),version:fingerprint(c.dataVersion.dir,{owned:true,deadline}),state:fingerprint(c.stateDir,{owned:true,omit:['diagnostics'],deadline}),modules:Object.fromEntries(Object.entries(c.modules).map(([id,m])=>[id,fingerprint(m.dataDir,{owned:true,deadline})]))};
}
function writeReport(c,report){
 ownedPath(c.stateDir,{directory:true,privateDir:true});const directory=path.join(c.stateDir,'diagnostics');assertNoLinks(directory);
 if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});ownedPath(directory,{directory:true,privateDir:true});
 const file=path.join(directory,'uvcs-verify-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()+'.json');
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
 try{fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
const safeCode=e=>/^UVCS_[A-Z_]+$/.test(e?.code||'')?e.code:'UVCS_VERIFICATION_FAILED';
export async function verifyNativeUvcs(configFile,options={}){
 const report={schemaVersion:1,kind:'native-uvcs-readonly-verification',ok:false,code:'UVCS_VERIFICATION_FAILED',runtime:{uid:process.getuid?.()??null,platform:process.platform,nodeVersion:process.version,cmVersion:null,docker:fs.existsSync('/.dockerenv')},submittedCount:0,matches:[]};
 let c;const totalMs=options.totalMs??180000,end=Date.now()+totalMs;
 try{
  if(!Number.isInteger(totalMs)||totalMs<1||totalMs>180000)throw uvcsError('UVCS_TIME_BUDGET_INVALID');
  ownedPath(configFile);const configBytes=fs.readFileSync(configFile,'utf8');c=validateConfig(JSON.parse(configBytes));
  if(path.resolve(configFile)!==path.join(c.native.dataRoot,'config','web.json'))throw uvcsError('UVCS_CONFIG_INVALID');
  ownedPath(c.stateDir,{directory:true,privateDir:true});
  if(!c.dataVersion?.enabled)throw uvcsError('UVCS_DISABLED');
  assertNativeUvcsPrepared(c);
  // The verification action must never create coordination files or repair a
  // missing installation. Existing SQLite locks serialize with lifecycle and
  // direct supervisor starts without touching the queue or client workspace.
  for(const name of ['native-lifecycle.sqlite','native-ownership.sqlite'])ownedPath(path.join(c.stateDir,name));
  resolveNativeCmPath(c.dataVersion.cmPath);
  await withNativeLifecycleLock(c.stateDir,async()=>{
   const ownership=new DatabaseSync(path.join(c.stateDir,'native-ownership.sqlite'));
   try{
    try{ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{throw uvcsError('UVCS_SERVICE_UNCONFIRMED');}
    if(fs.readFileSync(configFile,'utf8')!==configBytes)throw uvcsError('UVCS_CONFIG_CHANGED');
    stopped(c);assertNativeUvcsPrepared(c);
    const before=protectedState(c,configFile,end);let rows;
    try{
     rows=queueRows(c);report.submittedCount=rows.length;
     if(Date.now()>=end)throw uvcsError('UVCS_TIMEOUT');const cm=nativeCm(c,{...options,totalMs:Math.max(1,end-Date.now())});
     if(!matchingRegistration(c,await cm.list()))throw uvcsError('UVCS_REGISTRATION_MISSING');
     const version=(await cm.version()).trim();if(!/^\d+(?:\.\d+){2,5}$/.test(version))throw uvcsError('UVCS_VERSION_INVALID');report.runtime.cmVersion=version;
     if(repositoryKey((await cm.repository()).trim())!==repositoryKey(c.dataVersion.repository))throw uvcsError('UVCS_REPOSITORY_MISMATCH');
     for(const row of rows){
      const lines=(await cm.event(row.id)).trim().split(/\r?\n/).filter(Boolean);
      if(lines.length!==1||!/^\d+\|[^|]+$/.test(lines[0]))throw uvcsError('UVCS_EVENT_LOOKUP_INVALID');
      const [id,date]=lines[0].split('|');if(!Number.isFinite(Date.parse(date))||'cs:'+id!==row.changeset)throw uvcsError('UVCS_EVENT_LOOKUP_MISMATCH');
      report.matches.push({id:row.id,changeset:row.changeset});
     }
     if(JSON.stringify(queueRows(c))!==JSON.stringify(rows))throw uvcsError('UVCS_READONLY_STATE_CHANGED');
    }finally{
     // Official clients can refresh authentication/cache even during queries.
     // Surface those writes accurately; never call a mutating recovery helper.
     if(JSON.stringify(protectedState(c,configFile,end))!==JSON.stringify(before))throw uvcsError('UVCS_READONLY_STATE_CHANGED');
    }
   }finally{ownership.close();}
  },{timeoutMs:0});
  report.ok=true;report.code='UVCS_VERIFIED';
 }catch(error){report.code=safeCode(error);}
 if(c){try{writeReport(c,report);}catch{report.ok=false;report.code='UVCS_REPORT_UNAVAILABLE';}}
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length!==4||process.argv[2]!=='--config'){console.error('UVCS_CONFIG_INVALID');process.exitCode=1;}
 else verifyNativeUvcs(process.argv[3]).then(report=>{console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}).catch(()=>{console.error('UVCS_VERIFICATION_FAILED');process.exitCode=1;});
}
