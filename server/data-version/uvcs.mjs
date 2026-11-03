import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';

const modules = new Set(['purchase','sales','overview']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), {code});
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const text = (value, max=2000) => typeof value === 'string' && value.length <= max;

// Check each existing component, including junctions above the configured root.
export function assertNoLinks(file) {
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw fail('DATA_VERSION_PATH_INVALID');
    }
    if (stat.isSymbolicLink()) throw fail('DATA_VERSION_PATH_INVALID');
  }
}

function relativeFile(value) {
  if (!text(value, 1024) || !value || /[\\:\u0000-\u001f]/.test(value) || path.isAbsolute(value) || value.split('/').some(part=>!part || part==='.' || part==='..' || /[. ]$/.test(part))) throw fail('DATA_VERSION_PATH_INVALID');
  return value;
}

export function normalizeEvent(event, expected={}) {
  if (!event || event.schemaVersion !== 1 || !validId(event.id) || !modules.has(event.module) || (expected.id && expected.id !== event.id) || (expected.module && expected.module !== event.module) || !Number.isFinite(Date.parse(event.createdAt)) || !text(event.actor?.id,256) || !text(event.actor?.label,256) || !text(event.action,256) || !text(event.summary) || !event.counts || ['insert','update','delete'].some(key=>!Number.isSafeInteger(event.counts[key]) || event.counts[key]<0) || event.snapshot?.path !== 'snapshot.json' || !/^[a-f0-9]{64}$/.test(event.snapshot?.sha256) || !Array.isArray(event.attachments)) throw fail('DATA_VERSION_INVALID_EVENT');
  const seen = new Set(['snapshot.json','event.json']);
  const attachments = event.attachments.map(attachment=>{
    const rel = relativeFile(attachment?.path);
    const lower = rel.toLowerCase();
    if (!rel.startsWith('attachments/') || seen.has(lower) || !/^[a-f0-9]{64}$/.test(attachment.sha256) || !Number.isSafeInteger(attachment.bytes) || attachment.bytes<0) throw fail('DATA_VERSION_INVALID_EVENT');
    seen.add(lower);
    return {path:rel, sha256:attachment.sha256, bytes:attachment.bytes};
  });
  return {schemaVersion:1,id:event.id,module:event.module,createdAt:event.createdAt,actor:{id:event.actor.id,label:event.actor.label},action:event.action,summary:event.summary,counts:{insert:event.counts.insert,update:event.counts.update,delete:event.counts.delete},snapshot:{path:'snapshot.json',sha256:event.snapshot.sha256},attachments};
}

export function verifyEventFiles(rawEvent, eventDir) {
  const event = normalizeEvent(rawEvent);
  assertNoLinks(eventDir);
  const files = [event.snapshot,...event.attachments].map(item=>{
    const absolute = path.join(eventDir,relativeFile(item.path));
    assertNoLinks(absolute);
    let bytes;
    try {
      if (!fs.lstatSync(absolute).isFile()) throw fail('DATA_VERSION_PATH_INVALID');
      bytes = fs.readFileSync(absolute);
    } catch (error) { throw error.code?.startsWith('DATA_VERSION_') ? error : fail('DATA_VERSION_SNAPSHOT_UNAVAILABLE'); }
    if (sha256(bytes)!==item.sha256 || (item.bytes!==undefined && item.bytes!==bytes.length)) throw fail('DATA_VERSION_HASH_MISMATCH');
    return {path:item.path,bytes};
  });
  return {event,files};
}

function syncLeaseDirectory(directory) {
  if(process.platform==='win32')return;
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function durableJson(file,value) {
  const directory=path.dirname(file);assertNoLinks(directory);fs.mkdirSync(directory,{recursive:true});
  const temporary=file+'.tmp';assertNoLinks(file);assertNoLinks(temporary);
  const fd=fs.openSync(temporary,'w',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);syncLeaseDirectory(directory);
}
function processAlive(pid) {
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');}
}
async function acquireCommandGuard(workspace) {
  assertNoLinks(workspace);
  let canonical=fs.realpathSync(workspace);if(process.platform==='win32')canonical=canonical.toLowerCase();
  const key=sha256(canonical),server=net.createServer(socket=>socket.destroy());
  const address=process.platform==='win32'?`\\\\.\\pipe\\lingtu-cm-command-${key}`:{host:'127.0.0.1',port:55001+parseInt(key.slice(0,6),16)%10000,exclusive:true};
  return new Promise((resolve,reject)=>{
    server.once('error',error=>reject(fail(error.code==='EADDRINUSE'?'UVCS_COMMAND_BUSY':'UVCS_COMMAND_LEASE_UNVERIFIED')));
    server.listen(address,()=>{server.unref();resolve(server);});
  });
}

// A parent can die between CreateProcess and persisting child.pid. Windows keeps
// the original PPID, so inspect the exact executable under that deceased owner.
// An unavailable inspector or a non-Windows unknown PID fails closed.
export async function inspectOrphanProcesses({ownerPid,executable}) {
  if(process.platform!=='win32' || !Number.isSafeInteger(ownerPid) || ownerPid<1 || !/^[a-zA-Z0-9_.-]+$/.test(executable))throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');
  const name=/\.exe$/i.test(executable)?executable:executable+'.exe';
  const script=`$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${ownerPid} AND Name = '${name}'" | Select-Object ProcessId); ConvertTo-Json -Compress -InputObject $items`;
  const powershell=path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const output=await new Promise((resolve,reject)=>{
    const child=spawn(powershell,['-NoProfile','-NonInteractive','-Command',script],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let text='',bytes=0,bad=false;
    const timer=setTimeout(()=>{bad=true;child.kill();},30000);
    child.on('error',()=>{clearTimeout(timer);reject(fail('UVCS_COMMAND_LEASE_UNVERIFIED'));});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){bad=true;child.kill();}else if(stream===child.stdout)text+=chunk.toString('utf8');});
    child.on('close',code=>{clearTimeout(timer);if(bad||code!==0)reject(fail('UVCS_COMMAND_LEASE_UNVERIFIED'));else resolve(text);});
  });
  try {
    const rows=JSON.parse(output.replace(/^\uFEFF/,''));
    if(!Array.isArray(rows) || rows.some(row=>!Number.isSafeInteger(row.ProcessId)||row.ProcessId<1))throw Error();
    return rows.map(row=>({pid:row.ProcessId}));
  }catch{throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');}
}

// Keep command diagnostics private. The durable lease survives uploader death;
// unlike the worker's OS pipe it also protects against a still-running orphan cm.
export async function runCm(file, args, options) {
  const workspace=path.resolve(options.cwd),leaseFile=path.join(workspace,'.lingtu-data-version-staging','command-lease.json');
  const guard=await acquireCommandGuard(workspace);
  let guardReleased=false;
  const releaseGuard=()=>{if(guardReleased)return Promise.resolve();guardReleased=true;return new Promise(resolve=>guard.close(resolve));};
  const readLease=()=>{
    assertNoLinks(leaseFile);if(!fs.existsSync(leaseFile))return null;
    try {
      const record=JSON.parse(fs.readFileSync(leaseFile,'utf8'));
      if(record.schemaVersion!==1 || !/^[a-f0-9-]{36}$/i.test(record.token) || !Number.isSafeInteger(record.ownerPid) || record.ownerPid<1 || !(record.childPid===null || Number.isSafeInteger(record.childPid)&&record.childPid>0) || !Number.isFinite(Date.parse(record.startedAt)) || !/^[a-zA-Z0-9_.-]+$/.test(record.executable))throw Error();
      return record;
    }catch{throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');}
  };
  let lease;
  try {
    const previous=readLease();
    if(previous) {
      if(processAlive(previous.ownerPid) || previous.childPid!==null&&processAlive(previous.childPid))throw fail('UVCS_COMMAND_BUSY');
      if(previous.childPid===null) {
        let children;
        try{children=await (options.inspectOrphanProcesses??inspectOrphanProcesses)({ownerPid:previous.ownerPid,executable:previous.executable});}
        catch{throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');}
        if(!Array.isArray(children) || children.some(child=>!Number.isSafeInteger(child.pid)||child.pid<1))throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');
        if(children.length)throw fail('UVCS_COMMAND_BUSY');
      }
      fs.unlinkSync(leaseFile);syncLeaseDirectory(path.dirname(leaseFile));
    }
    lease={schemaVersion:1,token:randomUUID(),ownerPid:process.pid,childPid:null,startedAt:new Date().toISOString(),executable:path.basename(file)};
    if(!/^[a-zA-Z0-9_.-]+$/.test(lease.executable))throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');
    durableJson(leaseFile,lease);
  }catch(error){await releaseGuard();throw error.code?.startsWith('UVCS_')?error:fail('UVCS_COMMAND_LEASE_UNVERIFIED');}
  const clearLease=()=>{const current=readLease();if(current?.token!==lease.token)throw fail('UVCS_COMMAND_LEASE_UNVERIFIED');fs.unlinkSync(leaseFile);syncLeaseDirectory(path.dirname(leaseFile));};
  return new Promise((resolve,reject)=>{
    let child,finished=false,closed=false,outputBytes=0,terminalError=null,timer,killTimer;
    const chunks=[];
    const settle=async(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);await releaseGuard();error?reject(error):resolve(value);};
    const killAndWait=error=>{
      terminalError??=error;
      if(closed || killTimer)return;
      try{child?.kill();}catch{}
      // If termination cannot be confirmed, retain the lease. Later commands
      // must verify this exact child has exited, and never kill an unrelated PID.
      killTimer=setTimeout(()=>settle(terminalError),options.killGraceMs??5000);
    };
    try {child=(options.spawnProcess??spawn)(file,args,{cwd:workspace,shell:false,windowsHide:true,stdio:[options.input===undefined?'ignore':'pipe','pipe','pipe']});}
    catch {try{clearLease();}catch{}settle(fail('UVCS_UNAVAILABLE'));return;}
    child.on('error',()=>{terminalError??=fail('UVCS_UNAVAILABLE');});
    child.on('close',async code=>{
      closed=true;clearTimeout(timer);clearTimeout(killTimer);
      let cleanupError=null;try{clearLease();}catch{cleanupError=fail('UVCS_COMMAND_LEASE_UNVERIFIED');}
      await settle(terminalError??cleanupError??(code===0?null:fail('UVCS_UNAVAILABLE')),{code,stdout:Buffer.concat(chunks).toString('utf8')});
    });
    for(const [stream,collect] of [[child.stdout,true],[child.stderr,false]])stream?.on('data',chunk=>{
      outputBytes+=chunk.length;
      if(outputBytes>(options.maxBuffer??1024*1024)){killAndWait(fail('UVCS_OUTPUT_LIMIT'));return;}
      if(collect)chunks.push(Buffer.from(chunk));
    });
    if(Number.isSafeInteger(child.pid)&&child.pid>0) {
      lease.childPid=child.pid;
      try{durableJson(leaseFile,lease);}catch{killAndWait(fail('UVCS_COMMAND_LEASE_UNVERIFIED'));}
    }
    timer=setTimeout(()=>killAndWait(fail('UVCS_TIMEOUT')),options.timeout??60000);
    if(options.input!==undefined) {
      try {
        if(!child.stdin)throw Error();
        child.stdin.on('error',()=>killAndWait(fail('UVCS_STDIN_UNAVAILABLE')));
        child.stdin.end(String(options.input).replace(/[\r\n]*$/,'')+'\n\n','utf8');
      }catch{killAndWait(fail('UVCS_STDIN_UNAVAILABLE'));}
    }
  });
}

const repositoryKey = value => value.replace(/^rep:/,'').replace(/@repserver:/,'@');
const moduleLabels = {purchase:'采购',sales:'销售',overview:'经营总览'};

export function createUvcsAdapter({cmPath,workspace,repository,run=runCm}) {
  if (!text(cmPath,4096) || !path.isAbsolute(workspace??'') || !text(repository,1000) || !repository || /['"\u0000-\u001f]/.test(repository)) throw fail('UVCS_CONFIG_INVALID');
  workspace=path.resolve(workspace);
  async function command(args,input) {
    let result;
    try {result=await run(cmPath,args,{cwd:workspace,shell:false,windowsHide:true,timeout:args[0]==='checkin'?600000:60000,maxBuffer:1024*1024,...(input===undefined?{}:{input})});}
    catch(error){throw error.code?.startsWith('UVCS_') ? error : fail('UVCS_UNAVAILABLE');}
    if (result?.code && result.code!==0) throw fail('UVCS_UNAVAILABLE');
    return typeof result==='string'?result:String(result?.stdout??'');
  }
  function pathCommand(prefix,paths,suffix=[]) {
    const args=[...prefix,...paths,...suffix];
    // Windows CreateProcess is limited to 32767 UTF-16 code units. Reserve
    // space for executable/escaping and use the official stdin path-list mode.
    const commandLength=cmPath.length+args.reduce((length,arg)=>length+arg.length*2+3,0);
    return commandLength>16000?command([...prefix,'-',...suffix],paths.join('\n')+'\n\n'):command(args);
  }
  async function checkWorkspace() {
    assertNoLinks(workspace);
    const result=(await command(['fileinfo',workspace,'--format={RepSpec}'])).trim();
    if (repositoryKey(result)!==repositoryKey(repository)) throw fail('UVCS_WORKSPACE_REPOSITORY_MISMATCH');
  }
  const stagingRoot=path.join(workspace,'.lingtu-data-version-staging');
  const stageFile=module=>path.join(stagingRoot,module+'.json');
  const sameEvent=(one,two)=>JSON.stringify(one)===JSON.stringify(two);
  function directoriesFor(event) {
    const directories=new Set([event.module]);
    for(const item of [event.snapshot,...event.attachments]) {
      let parent=path.posix.dirname(event.module+'/'+item.path);
      while(parent!=='.'){directories.add(parent);parent=path.posix.dirname(parent);}
    }
    return [...directories].sort((one,two)=>one.split('/').length-two.split('/').length || one.localeCompare(two));
  }
  function readStage(module) {
    const file=stageFile(module);assertNoLinks(file);
    if(!fs.existsSync(file))return null;
    try {
      if(!fs.lstatSync(file).isFile())throw Error();
      const raw=JSON.parse(fs.readFileSync(file,'utf8'));
      const event=normalizeEvent(raw.event,{module}),previous=raw.previous===null?null:normalizeEvent(raw.previous,{module});
      const possibleDirectories=new Set(directoriesFor(event));
      if(raw.schemaVersion!==1 || raw.repository!==repositoryKey(repository) || !Array.isArray(raw.addDirectories) || new Set(raw.addDirectories).size!==raw.addDirectories.length || !raw.addDirectories.every(directory=>possibleDirectories.has(directory)))throw Error();
      return {schemaVersion:1,repository:repositoryKey(repository),event,previous,addDirectories:raw.addDirectories};
    } catch {throw fail('DATA_VERSION_STAGING_INVALID');}
  }
  function syncDirectory(directory) {
    // Directory fsync is supported on Unix. Windows flushes the journal file
    // before its atomic rename; opening a directory for fsync is unsupported.
    if(process.platform==='win32')return;
    const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  function writeStage(stage) {
    assertNoLinks(stagingRoot);fs.mkdirSync(stagingRoot,{recursive:true});assertNoLinks(stagingRoot);
    const file=stageFile(stage.event.module),temporary=file+'.tmp';assertNoLinks(file);assertNoLinks(temporary);
    const fd=fs.openSync(temporary,'w',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(stage)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,file);syncDirectory(stagingRoot);
  }
  function deletedFiles(stage) {
    return (stage.previous?.attachments??[]).filter(item=>!stage.event.attachments.some(current=>current.path===item.path));
  }
  function inspectTarget(stage) {
    const target=path.join(workspace,stage.event.module);
    const allowed=new Set(['snapshot.json','event.json',...(stage.previous?.attachments??[]).map(item=>item.path),...stage.event.attachments.map(item=>item.path)]);
    function inspect(directory,rel='') {
      if(!fs.existsSync(directory))return;
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
        const child=path.join(directory,entry.name),relative=rel+entry.name;assertNoLinks(child);
        if(entry.isDirectory()) {
          if(relative!=='attachments' && !relative.startsWith('attachments/') && ![...allowed].some(item=>item.startsWith(relative+'/')))throw fail('DATA_VERSION_WORKSPACE_DIRTY');
          inspect(child,relative+'/');
        } else if(!entry.isFile() || !allowed.has(relative))throw fail('DATA_VERSION_WORKSPACE_DIRTY');
      }
    }
    inspect(target);
    // In particular, a manually changed old attachment is never deleted just
    // because the interrupted event used to own a file at the same pathname.
    for(const item of deletedFiles(stage)) {
      const absolute=path.join(target,item.path);assertNoLinks(absolute);
      if(fs.existsSync(absolute) && sha256(fs.readFileSync(absolute))!==item.sha256)throw fail('DATA_VERSION_WORKSPACE_DIRTY');
    }
  }
  function clearConfirmedStage(stage) {
    inspectTarget(stage);
    const target=path.join(workspace,stage.event.module);
    try {
      verifyEventFiles(stage.event,target);
      const local=normalizeEvent(JSON.parse(fs.readFileSync(path.join(target,'event.json'),'utf8')),{module:stage.event.module});
      if(!sameEvent(local,stage.event) || deletedFiles(stage).some(item=>fs.existsSync(path.join(target,item.path))))throw Error();
    } catch {throw fail('DATA_VERSION_STAGING_RECONCILIATION_REQUIRED');}
    const file=stageFile(stage.event.module);assertNoLinks(file);fs.unlinkSync(file);syncDirectory(stagingRoot);
  }
  async function findEvent(eventId) {
    if (!validId(eventId)) throw fail('DATA_VERSION_INVALID_EVENT');
    const query=`where comment like '%事件：${eventId}]' on repository '${repository}'`;
    const output=await command(['find','changeset',query,'--format={changesetid}|{date}','--dateformat=yyyy-MM-ddTHH:mm:ss.fffK','--nototal','--encoding=utf-8']);
    const lines=output.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    if (lines.length!==1 || !/^\d+\|/.test(lines[0])) throw fail('UVCS_EVENT_LOOKUP_INVALID');
    const [id,date]=lines[0].split('|');
    if (!Number.isFinite(Date.parse(date))) throw fail('UVCS_EVENT_LOOKUP_INVALID');
    for(const module of modules) {
      const stage=readStage(module);
      if(stage?.event.id===eventId){await checkWorkspace();clearConfirmedStage(stage);}
    }
    return {changeset:`cs:${id}`,submittedAt:new Date(date).toISOString()};
  }
  async function commit(rawEvent,eventDir) {
    const {event,files}=verifyEventFiles(rawEvent,eventDir);
    await checkWorkspace();
    const target=path.join(workspace,event.module);assertNoLinks(target);
    let stage=readStage(event.module);
    if(stage) {
      if(!sameEvent(stage.event,event))throw fail('DATA_VERSION_STAGING_PENDING');
    } else {
      const previousFile=path.join(target,'event.json');let previous=null;
      if(fs.existsSync(previousFile)) {
        assertNoLinks(previousFile);
        try {previous=normalizeEvent(JSON.parse(fs.readFileSync(previousFile,'utf8')),{module:event.module});verifyEventFiles(previous,target);}
        catch {throw fail('DATA_VERSION_WORKSPACE_DIRTY');}
      }
      stage={schemaVersion:1,repository:repositoryKey(repository),event,previous,addDirectories:directoriesFor(event).filter(directory=>!fs.existsSync(path.join(workspace,directory)))};
      inspectTarget(stage);
      // This record is durable before event.json, snapshots, attachments, or cm
      // pending changes can be touched. A fresh adapter can resume every path.
      writeStage(stage);
    }
    inspectTarget(stage);
    const newDirectories=stage.addDirectories.map(directory=>path.join(workspace,directory));
    function ensure(directory) {
      if(fs.existsSync(directory)){assertNoLinks(directory);return;}
      if(directory!==workspace)ensure(path.dirname(directory));
      fs.mkdirSync(directory);
    }
    ensure(target);
    const outputs=[...files,{path:'event.json',bytes:Buffer.from(JSON.stringify(event,null,2)+'\n')}];
    const paths=[];
    for(const item of outputs){
      const destination=path.join(target,item.path);ensure(path.dirname(destination));assertNoLinks(destination);
      fs.writeFileSync(destination,item.bytes);paths.push(destination);
    }
    const removed=deletedFiles(stage).map(item=>path.join(target,item.path));
    for(const directory of newDirectories)await command(['add','--ignorefailed',directory]);
    await pathCommand(['add','--ignorefailed'],paths);
    for(const file of removed)if(fs.existsSync(file))await command(['remove',file]);
    inspectTarget(stage);
    const clean=value=>value.replace(/[\r\n\u0000-\u001f|]/g,' ').slice(0,120);
    const comment=`${moduleLabels[event.module]}｜${clean(event.action)}｜新增${event.counts.insert}条、修改${event.counts.update}条、删除${event.counts.delete}条｜操作人：${clean(event.actor.label)}｜[事件：${event.id}]`;
    // Even an already absent file remains in this explicit list: its cm delete
    // may still be pending after the previous process's interrupted checkin.
    const output=await pathCommand(['checkin'],[...newDirectories,...paths,...removed],['--all',`-c=${comment}`]);
    const ids=[...output.matchAll(/\bcs:(\d+)(?=@|\b)/g)].map(match=>match[1]);
    if(new Set(ids).size!==1) throw fail('UVCS_CHANGESET_UNCONFIRMED');
    clearConfirmedStage(stage);
    return {changeset:`cs:${ids[0]}`,submittedAt:new Date().toISOString()};
  }
  return {findEvent,commit};
}
