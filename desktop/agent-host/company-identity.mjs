import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertPrivateFile,hostError} from './common.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
/** A Beta tenant is independent, but its dataset is the existing Beta gateway dataset. */
export function createCompanyIdentity({profile,storeDir}={}){
  const companyFile=path.join(profile,'company-identity.json'),gatewayFile=path.join(profile,'workbench-server','identity.json');
  const persisted=()=>['agent-tasks.sqlite','agent-owner.sqlite'].some(name=>fs.existsSync(path.join(storeDir,name)));
  const read=file=>{try{assertPrivateFile(profile,file);return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw hostError('COMPANY_IDENTITY_UNAVAILABLE','测试租户身份不可读取，已停止任务',409);}};
  if(!fs.existsSync(companyFile)){
    if(persisted())throw hostError('COMPANY_IDENTITY_MISSING','已有任务的测试租户身份缺失，不能生成替代身份',409);
    fs.mkdirSync(path.dirname(gatewayFile),{recursive:true,mode:0o700});
    if(!fs.existsSync(gatewayFile))try{fs.writeFileSync(gatewayFile,JSON.stringify({schemaVersion:1,serverId:randomUUID(),dataSetId:randomUUID()}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    const gateway=read(gatewayFile);if(gateway.schemaVersion!==1||!uuid(gateway.serverId)||!uuid(gateway.dataSetId))throw hostError('COMPANY_IDENTITY_INVALID','测试工作台身份无效',409);
    try{fs.writeFileSync(companyFile,JSON.stringify({schemaVersion:1,companyId:randomUUID(),serverId:gateway.serverId,dataSetId:gateway.dataSetId}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  function current(){
    const company=read(companyFile),gateway=read(gatewayFile);
    if(company.schemaVersion!==1||gateway.schemaVersion!==1||![company.companyId,company.serverId,company.dataSetId].every(uuid)||company.serverId!==gateway.serverId||company.dataSetId!==gateway.dataSetId)throw hostError('COMPANY_IDENTITY_CHANGED','测试租户与当前工作台数据集不一致，已停止任务',409);
    return {companyId:company.companyId,dataSetId:company.dataSetId};
  }
  current();return current;
}
