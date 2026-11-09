import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {assertNoLinks} from '../data-version/uvcs.mjs';

export const uvcsError=code=>Object.assign(Error(code),{code});
export const repositoryKey=value=>value.replace(/^rep:/,'').replace(/@repserver:/,'@');
const opaque=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=1000&&!/[\u0000-\u001f]/.test(value)&&!/^\{(?:wkname|wkid|path|wkspec|RepSpec)\}$/.test(value);
export function trustedIdentity(value,repository){
 if(!value||!opaque(value.id)||!opaque(value.name)||!opaque(value.repository)||/['"]/.test(value.repository)||repositoryKey(value.repository)!==repositoryKey(repository||''))throw uvcsError('UVCS_EXPECTED_IDENTITY_REQUIRED');
 return {id:value.id,name:value.name,repository:value.repository};
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function ownedPath(file,{directory=false,privateDir=false}={}){
 assertNoLinks(file);const st=fs.lstatSync(file);
 if(directory?!st.isDirectory():!st.isFile())throw uvcsError('UVCS_PATH_INVALID');
 if(process.platform!=='win32'&&(st.uid!==process.getuid()||privateDir&&(st.mode&0o077)))throw uvcsError('UVCS_OWNERSHIP_INVALID');
 return file;
}
export function fingerprint(root,{owned=false,omit=[],deadline=Infinity}={}){
 const budget=()=>{if(Date.now()>=deadline)throw uvcsError('UVCS_TIMEOUT');};budget();assertNoLinks(root);const items=[],buffer=Buffer.allocUnsafe(1024*1024);
 const walk=(dir,prefix='')=>{for(const name of fs.readdirSync(dir).sort()){
  budget();const file=path.join(dir,name),relative=prefix+name;if(omit.includes(relative))continue;const st=fs.lstatSync(file);
  if(st.isSymbolicLink()||owned&&process.platform!=='win32'&&st.uid!==process.getuid())throw uvcsError('UVCS_PATH_INVALID');
  if(st.isDirectory()){items.push([relative+'/']);walk(file,relative+'/');continue;}
  if(!st.isFile())throw uvcsError('UVCS_PATH_INVALID');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const before=fs.fstatSync(fd);if(before.ino!==st.ino||before.dev!==st.dev)throw uvcsError('UVCS_FILE_CHANGED');const digest=createHash('sha256');let bytes=0,n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))){budget();digest.update(buffer.subarray(0,n));bytes+=n;}const after=fs.fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes!==before.size)throw uvcsError('UVCS_FILE_CHANGED');items.push([relative,bytes,digest.digest('hex')]);}finally{fs.closeSync(fd);}
 }};walk(root);return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
export const metadataFingerprint=workspace=>fingerprint(path.join(workspace,'.plastic'));
const stateFile=c=>path.join(c.stateDir,'native-uvcs-registration.json');
function readState(c){try{ownedPath(stateFile(c));return JSON.parse(fs.readFileSync(stateFile(c),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function saveState(c,state){
 ownedPath(c.stateDir,{directory:true});const file=stateFile(c);assertNoLinks(file);const tmp=file+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(tmp,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
}
function canonical(file){const actual=fs.realpathSync(file);return process.platform==='win32'?actual.toLowerCase():actual;}
function identityAndPaths(c){
 const expected=trustedIdentity(c.native?.uvcsIdentity,c.dataVersion?.repository);
 for(const dir of [c.native.dataRoot,c.stateDir,c.dataVersion.dir,c.dataVersion.workspace])ownedPath(dir,{directory:true});
 ownedPath(c.native.home,{directory:true,privateDir:true});ownedPath(path.join(c.dataVersion.workspace,'.plastic'),{directory:true});
 if(!canonical(c.dataVersion.workspace).startsWith(canonical(c.dataVersion.dir)+path.sep)||!canonical(c.dataVersion.dir).startsWith(canonical(c.native.dataRoot)+path.sep)||!canonical(c.native.home).startsWith(canonical(c.native.dataRoot)+path.sep))throw uvcsError('UVCS_FINAL_PATH_REQUIRED');
 return expected;
}
export function assertNativeUvcsPrepared(c){
 if(!c.dataVersion?.enabled)return;
 const expected=identityAndPaths(c),state=readState(c);
 if(state?.schemaVersion!==1||state.status!=='verified'||state.workspace!==canonical(c.dataVersion.workspace)||!same(state.identity,expected))throw uvcsError('UVCS_REGISTRATION_NOT_PREPARED');
 // A successful submission legitimately updates .plastic. Its initial hash is
 // a migration audit baseline, never an immutable condition for future starts.
 return state;
}
export function assertNoUvcsLease(c){
 const file=path.join(c.dataVersion.workspace,'.lingtu-data-version-staging','command-lease.json');assertNoLinks(file);if(fs.existsSync(file))throw uvcsError('UVCS_COMMAND_LEASE_UNVERIFIED');
}
// System CLI only: root:root group-writable official installation directories
// are trusted. This exception never applies to ledger, HOME or recovery paths.
export function resolveNativeCmPath(input,{allowSymlink=false}={}){
 if(typeof input!=='string'||!path.isAbsolute(input))throw uvcsError('UVCS_EXECUTABLE_INVALID');
 const verifyChain=file=>{let current=path.parse(file).root;for(const part of ['',...file.slice(current.length).split(path.sep).filter(Boolean)]){
  if(part)current=path.join(current,part);const st=fs.lstatSync(current);
  if(process.platform!=='win32'&&(st.uid!==0||!st.isSymbolicLink()&&((st.mode&0o002)||(st.mode&0o020)&&st.gid!==0)))throw uvcsError('UVCS_EXECUTABLE_INVALID');
  if(st.isSymbolicLink()&&!allowSymlink)throw uvcsError('UVCS_EXECUTABLE_INVALID');
 }};
 verifyChain(path.resolve(input));const actual=fs.realpathSync(input);verifyChain(actual);
 if(!fs.statSync(actual).isFile())throw uvcsError('UVCS_EXECUTABLE_INVALID');return actual;
}
export function nativeCm(c,{timeoutMs=60000,totalMs=180000,signal}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isInteger(totalMs)||totalMs<1||totalMs>180000)throw uvcsError('UVCS_TIME_BUDGET_INVALID');
 assertNoUvcsLease(c);const executable=resolveNativeCmPath(c.dataVersion.cmPath);
 const end=Date.now()+totalMs;
 const command=args=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(uvcsError('UVCS_CANCELLED'));
  const remaining=Math.min(timeoutMs,end-Date.now());if(remaining<=0)return reject(uvcsError('UVCS_TIMEOUT'));
  let child,output='',bytes=0,failure,timer,exitTimer,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(exitTimer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
  const kill=code=>{failure??=uvcsError(code);try{child.kill('SIGKILL');}catch{}exitTimer??=setTimeout(()=>finish(uvcsError('UVCS_CHILD_EXIT_UNCONFIRMED')),5000);};
  const cancel=()=>kill('UVCS_CANCELLED');
  try{child=spawn(executable,args,{cwd:c.dataVersion.workspace,env:{...process.env,HOME:c.native.home,XDG_CONFIG_HOME:path.join(c.native.home,'.config')},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{return finish(uvcsError('UVCS_COMMAND_FAILED'));}
  timer=setTimeout(()=>kill('UVCS_TIMEOUT'),remaining);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024)kill('UVCS_OUTPUT_LIMIT');else if(stream===child.stdout)output+=chunk.toString('utf8');});
  child.once('error',()=>{failure??=uvcsError('UVCS_COMMAND_FAILED');});
  child.once('close',code=>finish(failure||(code!==0?uvcsError('UVCS_COMMAND_FAILED'):null),output));
 });
 return {
  version:()=>command(['version']),
  list:()=>command(['workspace','list','--format={wkname}{tab}{path}{tab}{wkid}{tab}{wkspec}']),
  selector:()=>command(['showselector',c.dataVersion.workspace]),
  repository:()=>command(['fileinfo',c.dataVersion.workspace,'--format={RepSpec}']),
  event:id=>{if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))throw uvcsError('UVCS_EVENT_INVALID');trustedIdentity(c.native.uvcsIdentity,c.dataVersion.repository);return command(['find','changeset',`where comment like '%事件：${id}]' on repository '${c.dataVersion.repository}'`,'--format={changesetid}|{date}','--dateformat=yyyy-MM-ddTHH:mm:ss.fffK','--nototal','--encoding=utf-8']);}
 };
}
export function matchingRegistration(c,output){
 const expected=trustedIdentity(c.native.uvcsIdentity,c.dataVersion.repository),target=canonical(c.dataVersion.workspace);
 const rows=output.trim()?output.trimEnd().split(/\r?\n/).map(line=>line.split('\t')):[];
 if(rows.some(r=>r.length!==4||!r.every(opaque)||!path.isAbsolute(r[1])))throw uvcsError('UVCS_REGISTRATION_INVALID');
 const matches=rows.filter(r=>{const p=path.resolve(r[1]);return (process.platform==='win32'?p.toLowerCase():p)===target;});
 if(!matches.length)return false;
 if(matches.length!==1||matches[0][0]!==expected.name||matches[0][2]!==expected.id||rows.some(r=>r!==matches[0]&&(r[2]===expected.id||r[0]===expected.name)))throw uvcsError('UVCS_REGISTRATION_IDENTITY_MISMATCH');
 return true;
}
export function markNativeUvcsPending(c,stateDir=c.stateDir){
 const workspace=path.resolve(c.dataVersion.workspace);saveState({...c,stateDir},{schemaVersion:1,status:'pending',identity:trustedIdentity(c.native.uvcsIdentity,c.dataVersion.repository),workspace:process.platform==='win32'?workspace.toLowerCase():workspace,sourceMetadataHash:c.native.uvcsSourceMetadataHash});
}
export async function prepareNativeUvcs(c,options={}){
 if(!c.dataVersion?.enabled)return;
 const expected=identityAndPaths(c);assertNoUvcsLease(c);
 // Publication is observable: the final config must already name this exact
 // final workspace. A staging directory is never registered with the client.
 const configFile=path.join(c.native.dataRoot,'config','web.json');ownedPath(configFile);const published=JSON.parse(fs.readFileSync(configFile,'utf8'));
 if(published.dataVersion?.workspace!==c.dataVersion.workspace||published.native?.dataRoot!==c.native.dataRoot)throw uvcsError('UVCS_FINAL_PATH_REQUIRED');
 const previous=readState(c),verified=previous?.status==='verified';
 if(previous&&(!same(previous.identity,expected)||previous.workspace!==canonical(c.dataVersion.workspace)))throw uvcsError('UVCS_REGISTRATION_IDENTITY_MISMATCH');
 const state={schemaVersion:1,status:'pending',identity:expected,workspace:canonical(c.dataVersion.workspace),sourceMetadataHash:verified?metadataFingerprint(c.dataVersion.workspace):(previous?.sourceMetadataHash??c.native.uvcsSourceMetadataHash)};
 if(!verified){saveState(c,state);if(!/^[a-f0-9]{64}$/.test(state.sourceMetadataHash||'')||metadataFingerprint(c.dataVersion.workspace)!==state.sourceMetadataHash)throw uvcsError('UVCS_METADATA_CHANGED');}
 const before=fingerprint(c.dataVersion.workspace,{owned:true}),cm=nativeCm(c,options);
 try{
  const registered=matchingRegistration(c,await cm.list());
  if(!registered){saveState(c,state);await cm.selector();if(!matchingRegistration(c,await cm.list()))throw uvcsError('UVCS_REGISTRATION_MISSING');}
  if(fingerprint(c.dataVersion.workspace,{owned:true})!==before)throw uvcsError('UVCS_WORKSPACE_CHANGED');
  saveState(c,{...state,status:'verified',verifiedAt:new Date().toISOString()});
 }catch(error){saveState(c,state);throw error;}
 return {ok:true};
}

export async function assertNativeUvcsRegistration(c,{signal}={}){
 if(!c.dataVersion?.enabled)return;
 assertNativeUvcsPrepared(c);
 if(!matchingRegistration(c,await nativeCm(c,{timeoutMs:10000,totalMs:10000,signal}).list()))throw uvcsError('UVCS_REGISTRATION_MISSING');
}
