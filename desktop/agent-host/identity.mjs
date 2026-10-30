import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {validatePolicy} from '../workbench/policy.mjs';
import {atomicJson,hostError} from './common.mjs';

export function windowsPrincipal({run=execFileSync,platform=process.platform}={}){
  if(platform!=='win32')throw hostError('WINDOWS_IDENTITY_REQUIRED','此公司主机需要 Windows 登录身份',503);
  const output=run(path.join(process.env.SystemRoot||'C:\\Windows','System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']});
  const sid=output.match(/,"(S-1-5-(?:\d+-)*\d+)"\s*$/)?.[1];
  if(!sid)throw hostError('WINDOWS_IDENTITY_UNAVAILABLE','无法验证当前 Windows 登录身份',503);
  return {id:'windows:'+sid,login:'windows:'+sid,label:os.userInfo().username};
}
const revision=policy=>createHash('sha256').update(JSON.stringify(policy)).digest('hex');
const normalizePolicy=value=>{
  validatePolicy(value);
  return {schemaVersion:1,users:Object.fromEntries(Object.entries(value.users).sort(([a],[b])=>a.localeCompare(b)).map(([login,p])=>[login,{role:p.role,modules:[...new Set(p.modules)].sort(),canRunTasks:p.canRunTasks,enabled:p.enabled}]))};
};

/** The installer/first local launch binds this profile to its real Windows SID. */
export function createHostIdentity({storeDir,policyFile,principal=windowsPrincipal(),bootstrap=true}={}){
  const ownerFile=path.join(storeDir,'windows-owner.json'),sessionId=randomUUID();
  fs.mkdirSync(storeDir,{recursive:true,mode:0o700});
  if(!fs.existsSync(ownerFile)&&bootstrap){
    try{fs.writeFileSync(ownerFile,JSON.stringify({schemaVersion:1,id:principal.id}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  const readState=()=>{try{const raw=JSON.parse(fs.readFileSync(policyFile,'utf8'));return {policy:normalizePolicy(raw),receipts:raw._agentReceipts&&typeof raw._agentReceipts==='object'&&!Array.isArray(raw._agentReceipts)?raw._agentReceipts:{}};}catch(e){if(e.code==='ENOENT')return {policy:{schemaVersion:1,users:{}},receipts:{}};throw hostError('ACCESS_POLICY_UNAVAILABLE','成员权限记录不可读取',503);}};
  const readPolicy=()=>readState().policy;
  const owner=()=>{try{const record=JSON.parse(fs.readFileSync(ownerFile,'utf8'));return record.schemaVersion===1?record.id:null;}catch{return null;}};
  function resolveActor(id){
    if(typeof id!=='string')return null;
    if(id===principal.id&&id===owner())return {...principal,role:'admin',modules:[...WORKBENCH_MODULES],canRunTasks:true,enabled:true,sessionId,channel:'ui'};
    if(!id.startsWith('tailscale:'))return null;
    const login=id.slice('tailscale:'.length),p=readPolicy().users[login];
    if(!p?.enabled)return null;
    return {id,login,label:login,role:p.role,modules:[...p.modules],canRunTasks:p.canRunTasks,enabled:true,channel:'mcp'};
  }
  function requireAdmin(actor,trustedUi=false){const fresh=resolveActor(actor?.id);if(!fresh||fresh.role!=='admin'||!trustedUi)throw hostError('ADMIN_REQUIRED','此操作需要管理员在工作台确认',403);return fresh;}
  return {resolveActor,listAssignableActors({modules,name}={},ctx={}){
    const actor=resolveActor(ctx.actor?.id);
    if(!actor||!['admin','editor'].includes(actor.role)||actor.canRunTasks!==true)throw hostError('TASK_PERMISSION_REQUIRED','无权查询可分派员工',403);
    if(!Array.isArray(modules)||modules.some(id=>!WORKBENCH_MODULES.includes(id)||!actor.modules.includes(id))||name!==undefined&&(typeof name!=='string'||!name.trim()||name.length>100))throw hostError('PEOPLE_SCOPE_DENIED','人员查询必须限于已授权业务范围',403);
    const ids=[owner(),...Object.keys(readPolicy().users).map(login=>'tailscale:'+login)],needle=name?.trim().toLocaleLowerCase();
    const people=[...new Set(ids.filter(Boolean))].map(id=>resolveActor(id)).filter(person=>person?.enabled&&['admin','editor'].includes(person.role)&&person.canRunTasks===true&&modules.every(id=>person.modules.includes(id))&&(!needle||[person.id,person.login,person.label].some(value=>String(value||'').toLocaleLowerCase().includes(needle)))).map(person=>({id:person.id,label:person.label,modules:person.modules.filter(id=>modules.includes(id))}));
    return {people};
  },localActor(channel='ui'){
    const actor=resolveActor(principal.id);if(!actor)throw hostError('HOST_OWNER_DENIED','当前 Windows 用户不是此主机配置的所有者',403);
    if(!['ui','mcp','cli'].includes(channel))throw hostError('CHANNEL_DENIED','调用通道无效',403);
    return {...actor,channel};
  },requireAdmin,permissionsGet(_payload,{actor,trustedUi}){
    requireAdmin(actor,trustedUi);const policy=readPolicy();return {policy,revision:revision(policy)};
  },permissionsInspect(_payload,{actor}){
    const fresh=resolveActor(actor?.id);if(!fresh||fresh.role!=='admin')throw hostError('ADMIN_REQUIRED','仅管理员可准备人员权限变更',403);
    const policy=readPolicy();return {policy,revision:revision(policy)};
  },permissionsReceipt({idempotencyKey},{actor}){
    const fresh=resolveActor(actor?.id);if(!fresh||fresh.role!=='admin')throw hostError('ADMIN_REQUIRED','仅管理员可核对人员权限回执',403);
    const receipt=readState().receipts[idempotencyKey];return receipt?{state:'completed',idempotencyKey,receipt}:{state:'not_found',idempotencyKey};
  },permissionsSave(payload,{actor,trustedUi,approval,idempotencyKey}){
    requireAdmin(actor,trustedUi);const state=readState(),current=state.policy,policy=normalizePolicy(payload.policy),operationKey=payload.idempotencyKey;
    if(operationKey){
      if(typeof operationKey!=='string'||!/^[A-Za-z0-9._:-]{8,160}$/.test(operationKey)||idempotencyKey!==operationKey||!approval)throw hostError('AGENT_APPROVAL_REQUIRED','权限任务缺少已确认操作的凭据',403);
      const previous=state.receipts[operationKey];if(previous){if(previous.actorId!==actor.id||previous.revision!==revision(policy))throw hostError('IDEMPOTENCY_CONFLICT','此操作标识已用于其他权限变更',409);return {policy:current,revision:revision(current),receipt:previous};}
    }
    if(payload?.revision!==revision(current))throw hostError('REVISION_CONFLICT','人员权限已更新，请刷新后重新确认',409);
    // A remote administrator cannot revoke the last enabled remote administrator.
    if(actor.id.startsWith('tailscale:')&&!Object.values(policy.users).some(p=>p.enabled&&p.role==='admin'))throw hostError('LAST_ADMIN_REQUIRED','至少保留一名已启用的管理员',409);
    const receipt=operationKey?{kind:'permissions',idempotencyKey:operationKey,actorId:actor.id,beforeRevision:revision(current),revision:revision(policy),committedAt:new Date().toISOString()}:undefined;
    atomicJson(policyFile,{...policy,_agentReceipts:{...state.receipts,...(receipt?{[operationKey]:receipt}:{})}});return {policy,revision:revision(policy),...(receipt?{receipt}:{})};
  }};
}
