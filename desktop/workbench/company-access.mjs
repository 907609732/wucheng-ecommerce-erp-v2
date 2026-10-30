import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WORKBENCH_MODULES} from './actor.mjs';

export const companyLogin=value=>typeof value==='string'?value.trim().toLowerCase():'';
export const validCompanyLogin=value=>typeof value==='string'&&value===companyLogin(value)&&value.length>0&&value.length<=254&&!/[\s,\r\n]/.test(value);

/** Legacy role fields remain only as signed protocol compatibility values. */
export function withCompanyAccess(identity){
  return {...identity,role:'admin',modules:[...WORKBENCH_MODULES],canRunTasks:true,enabled:true,authenticated:true,accessMode:'company-shared'};
}

function noLinks(file){let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Object.assign(Error('公司登录记录路径被重定向'),{code:'COMPANY_DIRECTORY_INVALID',statusCode:503});}}

/** The gateway records identities only after its real Tailscale/session checks. */
export function readCompanyMembers(storeDir){
  const file=path.join(storeDir,'gateway.sqlite');noLinks(file);if(!fs.existsSync(file))return [];
  if(!fs.statSync(file).isFile())throw Object.assign(Error('公司登录记录无效'),{code:'COMPANY_DIRECTORY_INVALID',statusCode:503});
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='company_members'").get())return [];
    return db.prepare('SELECT login,label FROM company_members ORDER BY login').all().map(row=>{
      if(!validCompanyLogin(row.login)||typeof row.label!=='string'||row.label.length>254)throw Object.assign(Error('公司登录记录无效'),{code:'COMPANY_DIRECTORY_INVALID',statusCode:503});
      return {id:'tailscale:'+row.login,login:row.login,label:row.label||row.login};
    });
  }finally{db.close();}
}
