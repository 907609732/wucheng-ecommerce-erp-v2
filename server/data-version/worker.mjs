import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {databases} from '../config.mjs';
import {createUvcsAdapter,normalizeEvent,verifyEventFiles,assertNoLinks} from './uvcs.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeError=error=>/^(?:DATA_VERSION_|UVCS_)[A-Z_]+$/.test(error?.code??'')?error.code:'UVCS_UNAVAILABLE';
const confirmed=result=>result && /^cs:\d+$/.test(result.changeset);

// The OS releases this named pipe on process death. No stale PID file, timeout,
// or boot-time reset can let a second process overlap an in-flight cm command.
async function acquireLock(workspace) {
  let canonical=path.resolve(workspace);
  if(fs.existsSync(canonical)){assertNoLinks(canonical);canonical=fs.realpathSync(canonical);}
  if(process.platform==='win32')canonical=canonical.toLowerCase();
  const key=hash(canonical),server=net.createServer(socket=>socket.destroy());
  const address=process.platform==='win32'?`\\\\.\\pipe\\lingtu-data-version-${key}`:{host:'127.0.0.1',port:30000+parseInt(key.slice(0,6),16)%25000,exclusive:true};
  return new Promise((resolve,reject)=>{
    server.once('error',error=>error.code==='EADDRINUSE'?resolve(null):reject(fail('DATA_VERSION_LOCK_UNAVAILABLE')));
    server.listen(address,()=>{server.unref();resolve(server);});
  });
}

export function createDataVersionWorker({config,adapter}={}) {
  const enabled=config?.dataVersion?.enabled===true;
  if(!enabled)return {list:()=>({items:[],total:0}),detail:()=>null,summary:()=>({enabled:false,pending:0,failed:0,submitted:0,lastSubmittedAt:null}),retry:()=>null,tick:async()=>({processed:0}),close:async()=>{}};
  const settings=config.dataVersion;
  if(!path.isAbsolute(settings.dir??'') || !path.isAbsolute(settings.workspace??''))throw fail('DATA_VERSION_CONFIG_INVALID');
  const localHistoryCount=settings.localHistoryCount??10;
  if(!Number.isInteger(localHistoryCount)||localHistoryCount<1||localHistoryCount>1000)throw fail('DATA_VERSION_CONFIG_INVALID');
  const dir=path.resolve(settings.dir);
  assertNoLinks(dir);fs.mkdirSync(dir,{recursive:true});assertNoLinks(dir);
  const queueFile=path.join(dir,'queue.sqlite');
  for(const suffix of ['','-wal','-shm','-journal'])assertNoLinks(queueFile+suffix);
  const queue=new DatabaseSync(queueFile);
  queue.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS data_version_queue(
      id TEXT PRIMARY KEY,module TEXT NOT NULL,payload TEXT NOT NULL,
      fingerprint TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
      changeset TEXT,error TEXT,submitted_at TEXT,created_at TEXT NOT NULL,source_seq INTEGER NOT NULL DEFAULT 0,
      local_released_at TEXT,local_cleanup_started INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS data_version_maintenance(id TEXT PRIMARY KEY,module TEXT NOT NULL,error TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  const columns=new Set(queue.prepare('PRAGMA table_info(data_version_queue)').all().map(column=>column.name));
  for(const [name,type] of [['source_seq','INTEGER NOT NULL DEFAULT 0'],['local_released_at','TEXT'],['local_cleanup_started','INTEGER NOT NULL DEFAULT 0']])if(!columns.has(name))queue.exec(`ALTER TABLE data_version_queue ADD COLUMN ${name} ${type}`);
  adapter??=createUvcsAdapter(settings);
  let closing=false,closed=false,running=null,lock=null,closePromise=null;
  const assertOpen=()=>{if(closed || closing)throw fail('DATA_VERSION_CLOSED');};

  function discover() {
    assertOpen();
    for(const [module,file] of Object.entries(databases)) {
      const dataDir=config.modules?.[module]?.dataDir;
      if(!dataDir)continue;
      const sourceFile=path.join(dataDir,file);
      assertNoLinks(sourceFile);
      if(!fs.existsSync(sourceFile))continue;
      for(const suffix of ['-wal','-shm','-journal'])assertNoLinks(sourceFile+suffix);
      let source;
      try {
        source=new DatabaseSync(sourceFile,{readOnly:true});
        source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
        if(!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='data_version_events'").get())continue;
        for(const row of source.prepare('SELECT rowid AS source_seq,id,payload FROM data_version_events').iterate()) {
          let event,validationError=null;
          try {event=normalizeEvent(JSON.parse(row.payload),{id:row.id,module});}
          catch(error){validationError=safeError(error);event={schemaVersion:1,id:String(row.id),module,createdAt:'1970-01-01T00:00:00.000Z',actor:{id:'',label:''},action:'',summary:'版本事件校验失败',counts:{insert:0,update:0,delete:0},snapshot:{path:'snapshot.json',sha256:''},attachments:[]};}
          const payload=JSON.stringify(event),fingerprint=hash(payload);
          const existing=queue.prepare('SELECT fingerprint FROM data_version_queue WHERE id=?').get(event.id);
          if(existing && existing.fingerprint!==fingerprint){queue.prepare("UPDATE data_version_queue SET status='failed',error='DATA_VERSION_EVENT_CHANGED',next_at=? WHERE id=?").run(Number.MAX_SAFE_INTEGER,event.id);continue;}
          queue.prepare('INSERT OR IGNORE INTO data_version_queue(id,module,payload,fingerprint,status,error,next_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(event.id,module,payload,fingerprint,validationError?'failed':'pending',validationError,validationError?Number.MAX_SAFE_INTEGER:0,event.createdAt);
          queue.prepare('UPDATE data_version_queue SET source_seq=? WHERE id=? AND source_seq!=?').run(row.source_seq,event.id,row.source_seq);
        }
      } catch(error) {throw error.code?.startsWith('DATA_VERSION_')?error:fail('DATA_VERSION_SOURCE_UNAVAILABLE');}
      finally {source?.close();}
    }
  }
  function dto(row) {
    if(!row)return null;
    const event=JSON.parse(row.payload);
    return {...event,status:row.status,changeset:row.changeset??null,error:row.error??null,attempts:row.attempts,submittedAt:row.submitted_at??null};
  }
  function list(filters={}) {
    discover();
    const where=[],values=[];
    for(const [key,column] of [['module','module'],['status','status']])if(filters[key]){where.push(`${column}=?`);values.push(String(filters[key]));}
    if(filters.actor){where.push("(json_extract(payload,'$.actor.id')=? OR instr(json_extract(payload,'$.actor.label'),?)>0)");values.push(String(filters.actor),String(filters.actor));}
    for(const [key,operator] of [['from','>='],['to','<=']])if(filters[key]) {
      const date=new Date(filters[key]);if(!Number.isFinite(date.getTime()))throw fail('DATA_VERSION_FILTER_INVALID');
      where.push(`created_at${operator}?`);values.push(date.toISOString());
    }
    const clause=where.length?' WHERE '+where.join(' AND '):'';
    const limit=Math.max(1,Math.min(200,Math.trunc(Number(filters.limit)||50))),offset=Math.max(0,Math.trunc(Number(filters.offset)||0));
    const total=queue.prepare('SELECT count(*) AS n FROM data_version_queue'+clause).get(...values).n;
    const items=queue.prepare('SELECT * FROM data_version_queue'+clause+' ORDER BY created_at DESC,source_seq DESC,module,id DESC LIMIT ? OFFSET ?').all(...values,limit,offset).map(dto);
    return {items,total};
  }
  function detail(id){discover();return dto(queue.prepare('SELECT * FROM data_version_queue WHERE id=?').get(String(id)));}
  function summary() {
    discover();const counts={pending:0,failed:0,submitted:0};
    for(const row of queue.prepare('SELECT status,count(*) AS n FROM data_version_queue GROUP BY status').all())counts[row.status]=row.n;
    return {enabled:true,...counts,lastSubmittedAt:queue.prepare("SELECT max(submitted_at) AS value FROM data_version_queue WHERE status='submitted'").get().value??null};
  }
  function retry(id) {
    discover();
    queue.prepare("UPDATE data_version_queue SET status='pending',error=NULL,next_at=0 WHERE id=? AND status='failed' AND error!='DATA_VERSION_EVENT_CHANGED'").run(String(id));
    return dto(queue.prepare('SELECT * FROM data_version_queue WHERE id=?').get(String(id)));
  }
  function localCleanupPlan(row) {
    const event=normalizeEvent(JSON.parse(row.payload),{id:row.id,module:row.module});
    const eventsRoot=path.resolve(dir,'events'),moduleRoot=path.join(eventsRoot,event.module),target=path.resolve(moduleRoot,event.id);
    if(path.dirname(target)!==moduleRoot || path.relative(eventsRoot,target).split(path.sep).length!==2)throw fail('DATA_VERSION_PATH_INVALID');
    assertNoLinks(target);
    if(!fs.existsSync(target))return {target,files:[],directories:[]};
    if(!fs.lstatSync(target).isDirectory())throw fail('DATA_VERSION_PATH_INVALID');
    const expected=new Map([[event.snapshot.path,event.snapshot],...event.attachments.map(item=>[item.path,item]),['event.json',null]]);
    const allowedDirectories=new Set(['attachments']);
    for(const relative of expected.keys()) {
      let parent=path.posix.dirname(relative);
      while(parent!=='.'){allowedDirectories.add(parent);parent=path.posix.dirname(parent);}
    }
    const files=[],directories=[];
    function validateFile(absolute,relative) {
      assertNoLinks(absolute);if(!fs.lstatSync(absolute).isFile())throw fail('DATA_VERSION_PATH_INVALID');
      const bytes=fs.readFileSync(absolute),metadata=expected.get(relative);
      if(relative==='event.json') {
        let local;try{local=JSON.parse(bytes.toString('utf8'));}catch{throw fail('DATA_VERSION_LOCAL_CONTENT_CHANGED');}
        if(!isDeepStrictEqual(local,event))throw fail('DATA_VERSION_LOCAL_CONTENT_CHANGED');
      } else if(hash(bytes)!==metadata.sha256 || metadata.bytes!==undefined&&bytes.length!==metadata.bytes)throw fail('DATA_VERSION_HASH_MISMATCH');
    }
    function inspect(directory,relative='') {
      assertNoLinks(directory);
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
        const rel=relative+entry.name,absolute=path.join(directory,entry.name);assertNoLinks(absolute);
        if(entry.isDirectory()) {
          if(!allowedDirectories.has(rel))throw fail('DATA_VERSION_LOCAL_UNEXPECTED_CONTENT');
          inspect(absolute,rel+'/');
        } else {
          if(!expected.has(rel))throw fail('DATA_VERSION_LOCAL_UNEXPECTED_CONTENT');
          validateFile(absolute,rel);files.push({absolute,relative:rel});
        }
      }
      directories.push(directory);
    }
    inspect(target);
    if(!row.local_cleanup_started)for(const [relative,metadata] of expected)if(metadata&&!fs.existsSync(path.join(target,relative)))throw fail('DATA_VERSION_SNAPSHOT_UNAVAILABLE');
    return {target,files,directories,validateFile};
  }
  function pruneLocalHistory() {
    // Only the uploading lock owner runs maintenance. Queue and source outbox
    // metadata stay intact; the shared immutable blobs archive is never GC'd.
    const report=(row,error)=>{
      const code=/^DATA_VERSION_[A-Z_]+$/.test(error?.code??'')?error.code:'DATA_VERSION_LOCAL_CLEANUP_FAILED';
      let repeated=false;
      try {
        repeated=queue.prepare('SELECT error FROM data_version_maintenance WHERE id=?').get(row.id)?.error===code;
        queue.prepare('INSERT INTO data_version_maintenance(id,module,error,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET error=excluded.error,updated_at=excluded.updated_at').run(row.id,row.module,code,new Date().toISOString());
      }catch{}
      if(!repeated)console.warn('[data-version] local cleanup deferred module=%s event=%s code=%s',row.module,row.id,code);
    };
    try {
      for(const module of Object.keys(databases)) {
        const rows=queue.prepare("SELECT * FROM data_version_queue WHERE module=? AND status='submitted' ORDER BY created_at DESC,source_seq DESC,id DESC").all(module).slice(localHistoryCount);
        for(const row of rows) {
          if(row.local_released_at)continue;
          try {
            const plan=localCleanupPlan(row);
            // A durable progress flag permits resuming a partially unlinked
            // old snapshot while still verifying every remaining known file.
            if(!queue.prepare("UPDATE data_version_queue SET local_cleanup_started=1 WHERE id=? AND status='submitted'").run(row.id).changes)continue;
            for(const file of plan.files){plan.validateFile(file.absolute,file.relative);fs.unlinkSync(file.absolute);}
            // Never use recursive deletion: a newly added operator file causes
            // rmdir to fail safely, rather than being swept up in cleanup.
            for(const directory of plan.directories){assertNoLinks(directory);fs.rmdirSync(directory);}
            queue.prepare('UPDATE data_version_queue SET local_released_at=?,local_cleanup_started=0 WHERE id=?').run(new Date().toISOString(),row.id);
            queue.prepare('DELETE FROM data_version_maintenance WHERE id=?').run(row.id);
          }catch(error){report(row,error);}
        }
      }
    }catch(error){report({id:'maintenance',module:'system'},error);}
  }
  async function upload() {
    lock??=await acquireLock(settings.workspace);
    if(!lock)return {processed:0,busy:true};
    if(closing)return {processed:0};
    discover();let processed=0;
    // Respect event chronology even across retries; never replace a newer remote
    // module snapshot with an older event after a temporary failure.
    for(const row of queue.prepare("SELECT * FROM data_version_queue WHERE status!='submitted' ORDER BY created_at,source_seq,module,id").all()) {
      if(closing || row.next_at>Date.now())break;
      const attempts=row.attempts+1;
      queue.prepare('UPDATE data_version_queue SET attempts=? WHERE id=?').run(attempts,row.id);
      try {
        const event=JSON.parse(row.payload),eventDir=path.join(dir,'events',event.module,event.id);
        verifyEventFiles(event,eventDir);
        let result=await adapter.findEvent(event.id);
        if(!result)result=await adapter.commit(event,eventDir);
        if(!confirmed(result))throw fail('UVCS_CHANGESET_UNCONFIRMED');
        const submittedAt=Number.isFinite(Date.parse(result.submittedAt))?new Date(result.submittedAt).toISOString():new Date().toISOString();
        queue.prepare("UPDATE data_version_queue SET status='submitted',changeset=?,error=NULL,next_at=0,submitted_at=? WHERE id=?").run(result.changeset,submittedAt,row.id);
        processed++;
      } catch(error) {
        const delay=Math.min(300000,1000*2**Math.min(18,attempts-1));
        queue.prepare("UPDATE data_version_queue SET status='failed',error=?,next_at=? WHERE id=?").run(safeError(error),Date.now()+delay,row.id);
        break;
      }
    }
    if(!closing)pruneLocalHistory();
    return {processed};
  }
  function tick() {
    if(closing || closed)return Promise.resolve({processed:0});
    if(running)return running;
    running=upload().finally(()=>{running=null;});return running;
  }
  function close() {
    if(closePromise)return closePromise;
    closing=true;
    closePromise=(async()=>{
      try {await running;}finally {
        if(lock)await new Promise(resolve=>lock.close(resolve));
        lock=null;queue.close();closed=true;
      }
    })();
    return closePromise;
  }
  return {list,detail,summary,retry,tick,close};
}
