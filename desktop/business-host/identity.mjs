import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {readCompanyMembers,withCompanyAccess} from '../workbench/company-access.mjs';
import {hostError} from './common.mjs';

export function windowsPrincipal({run=execFileSync,platform=process.platform}={}){
  if(platform!=='win32')throw hostError('WINDOWS_IDENTITY_REQUIRED','此公司主机需要 Windows 登录身份',503);
  const output=run(path.join(process.env.SystemRoot||'C:\\Windows','System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']});
  const sid=output.match(/,"(S-1-5-(?:\d+-)*\d+)"\s*$/)?.[1];
  if(!sid)throw hostError('WINDOWS_IDENTITY_UNAVAILABLE','无法验证当前 Windows 登录身份',503);
  return {id:'windows:'+sid,login:'windows:'+sid,label:os.userInfo().username};
}

/** Bind the real Windows SID; remote identities come only from gateway login records. */
export function createHostIdentity({storeDir,principal=windowsPrincipal(),bootstrap=true}={}){
  const ownerFile=path.join(storeDir,'windows-owner.json'),sessionId=randomUUID(),gatewayDir=path.join(path.dirname(storeDir),'workbench-server');
  fs.mkdirSync(storeDir,{recursive:true,mode:0o700});
  if(!fs.existsSync(ownerFile)&&bootstrap){
    try{fs.writeFileSync(ownerFile,JSON.stringify({schemaVersion:1,id:principal.id}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  const owner=()=>{try{const record=JSON.parse(fs.readFileSync(ownerFile,'utf8'));return record.schemaVersion===1?record.id:null;}catch{return null;}};
  function resolveActor(id){
    if(typeof id!=='string')return null;
    if(id===principal.id&&id===owner())return withCompanyAccess({...principal,sessionId,channel:'ui'});
    if(!id.startsWith('tailscale:'))return null;
    const member=readCompanyMembers(gatewayDir).find(item=>item.id===id);
    return member?withCompanyAccess({...member,channel:'mcp'}):null;
  }
  function requireMember(actor,trustedUi=false){const fresh=resolveActor(actor?.id);if(!fresh||!trustedUi)throw hostError('AUTHENTICATED_UI_REQUIRED','请登录公司工作台并在界面确认',403);return fresh;}
  const removed=()=>{throw hostError('FEATURE_REMOVED','权限管理已移除，所有已登录成员统一使用全部业务功能',410);};
  return {resolveActor,requireMember,requireAdmin:requireMember,
    listAssignableActors({modules=[],name}={},ctx={}){
      if(!resolveActor(ctx.actor?.id))throw hostError('IDENTITY_REQUIRED','请先登录公司工作台',401);
      if(!Array.isArray(modules)||modules.some(id=>!WORKBENCH_MODULES.includes(id))||name!==undefined&&(typeof name!=='string'||!name.trim()||name.length>100))throw hostError('PEOPLE_QUERY_INVALID','人员查询条件无效');
      const needle=name?.trim().toLocaleLowerCase(),members=[...(owner()===principal.id?[principal]:[]),...readCompanyMembers(gatewayDir)];
      return {people:members.filter(person=>!needle||[person.id,person.login,person.label].some(value=>String(value||'').toLocaleLowerCase().includes(needle))).map(person=>({id:person.id,label:person.label||person.login,modules:modules.length?[...new Set(modules)]:[...WORKBENCH_MODULES]}))};
    },
    localActor(channel='ui'){
      const actor=resolveActor(principal.id);if(!actor)throw hostError('HOST_OWNER_DENIED','当前 Windows 用户不是此主机配置的所有者',403);
      if(!['ui','mcp','cli'].includes(channel))throw hostError('CHANNEL_DENIED','调用通道无效',403);
      return {...actor,channel};
    },
    // Old callers receive a definite removal result rather than retaining CRUD.
    permissionsGet:removed,permissionsInspect:removed,permissionsReceipt:removed,permissionsSave:removed
  };
}
