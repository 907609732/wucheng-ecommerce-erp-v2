import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MODULE_IDS=Object.freeze(['warehouse','purchase','sales','overview','exporter']);
export function serverAddress(input){
  let url;
  try{url=new URL(String(input).trim());}catch{throw Error('请填写 Tailscale HTTPS 服务器地址');}
  if(url.protocol!=='https:'||!url.hostname.endsWith('.ts.net')||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['8443','9443'].includes(url.port))throw Error('服务器地址必须使用私网 HTTPS：正式版 8443，测试版 9443');
  return url.origin;
}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
export class ConnectionStore{
  constructor(root){this.file=path.join(root,'workbench-connection.json');this.root=root;}
  read(){
    if(!fs.existsSync(this.file)){const initial={schemaVersion:1,mode:'standalone',clientId:crypto.randomUUID(),serverUrl:'',pins:null,migration:{state:'unchecked'}};atomic(this.file,initial);}
    const state=JSON.parse(fs.readFileSync(this.file,'utf8'));
    if(state.schemaVersion!==1||!['server','client','standalone'].includes(state.mode)||state.networkProvider!==undefined&&!['system','embedded'].includes(state.networkProvider))throw Error('连接配置版本无效');
    return state;
  }
  configure({mode,serverUrl,networkProvider},inventory=[]){
    if(!['server','client','standalone'].includes(mode))throw Error('请选择主服务器、客户端或单机');
    if(networkProvider!==undefined&&!['system','embedded'].includes(networkProvider))throw Error('请选择内置私网连接或现有 Tailscale 客户端');
    const previous=this.read(),url=mode==='client'||mode==='server'&&serverUrl?serverAddress(serverUrl):previous.serverUrl;
    const changed=url!==previous.serverUrl;
    const pending=inventory.some(row=>row.present);
    const next={...previous,mode,serverUrl:url,networkSuspended:false,configurationId:crypto.randomUUID(),pins:changed?null:previous.pins,modulePins:changed?{}:previous.modulePins,moduleCacheLocks:changed?{}:previous.moduleCacheLocks,...(networkProvider!==undefined?{networkProvider}:{} )};
    if(mode==='client'&&(changed||previous.mode!=='client'||previous.migration.state==='unchecked'||previous.migration.state==='empty'&&pending))next.migration={state:pending?'pending':'empty',inventory,sourceDigest:crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex')};
    atomic(this.file,next);return next;
  }
  assertConfiguration(expected){
    if(!expected)return;
    const current=this.read();
    if(['mode','serverUrl','clientId','configurationId'].some(key=>current[key]!==expected[key])||(current.networkProvider||'system')!==(expected.networkProvider||'system'))throw Object.assign(Error('连接设置已更改，已丢弃过期的服务器响应'),{code:'CONNECTION_CHANGED'});
  }
  bind({serverId,dataSetId,userId},expected){
    if(!serverId||!dataSetId||!userId)throw Object.assign(Error('服务器未返回完整身份信息'),{code:'SERVER_IDENTITY_MISSING'});
    this.assertConfiguration(expected);
    const state=this.read(),pins={serverId,dataSetId,userId};
    if(state.networkSuspended)throw Object.assign(Error('已暂停私网连接，请在设置中重新连接或登录'),{code:'TAILNET_SUSPENDED'});
    if(state.pins&&Object.keys(pins).some(key=>state.pins[key]!==pins[key])){
      atomic(this.file,{...state,cacheLocked:true,configurationId:crypto.randomUUID()});
      throw Object.assign(Error('服务器、账本或成员身份发生变化，已停止连接；请核对服务器设置和迁移状态'),{code:'DATASET_CHANGED'});
    }
    atomic(this.file,{...state,pins,cacheLocked:false});return pins;
  }
  archiveMigration(receipt){
    const state=this.read();
    if(!receipt||receipt.status!=='completed'||receipt.clientId!==state.clientId||receipt.sourceDigest!==state.migration.sourceDigest||receipt.serverId!==state.pins?.serverId||receipt.dataSetId!==state.pins?.dataSetId)throw Error('迁移核对回执与本机账本不符');
    const archive=path.join(this.root,'client-ledger-archives',new Date().toISOString().replaceAll(':','-')+'.json');
    atomic(archive,{...state.migration,receipt,archivedAt:new Date().toISOString()});
    atomic(this.file,{...state,migration:{...state.migration,state:'archived',receipt,archive}});
    return {state:'archived',archive};
  }
  canWrite(){return this.read().mode!=='client'||['empty','archived'].includes(this.read().migration.state);}
  recordMigrationSource({sourceDigest,sourceRevisions}){const state=this.read();atomic(this.file,{...state,migration:{...state.migration,state:'pending',sourceDigest,sourceRevisions}});}
  lockCache(module){
    if(module!==undefined&&!MODULE_IDS.includes(module))throw Error('未知模块');
    const state=this.read();atomic(this.file,{...state,...(module?{moduleCacheLocks:{...state.moduleCacheLocks,[module]:true}}:{cacheLocked:true}),configurationId:crypto.randomUUID()});
  }
  suspendNetwork(){const state=this.read();atomic(this.file,{...state,networkSuspended:true,cacheLocked:true,configurationId:crypto.randomUUID()});}
  resumeNetwork(){const state=this.read();atomic(this.file,{...state,networkSuspended:false,configurationId:crypto.randomUUID()});}
  bindModule(module,dataSetId,expected){
    if(!MODULE_IDS.includes(module)||typeof dataSetId!=='string'||!dataSetId)throw Object.assign(Error('服务器未返回模块账本身份，请更新主机模块'),{code:'MODULE_IDENTITY_MISSING'});
    this.assertConfiguration(expected);
    const state=this.read(),pinned=state.modulePins?.[module];
    if(pinned&&pinned!==dataSetId){this.lockCache(module);throw Object.assign(Error('此模块的正式账本已更换，已阻止打开；请联系管理员核对数据集'),{code:'DATASET_CHANGED'});}
    const moduleCacheLocks={...state.moduleCacheLocks};delete moduleCacheLocks[module];
    atomic(this.file,{...state,modulePins:{...state.modulePins,[module]:dataSetId},moduleCacheLocks});
  }
  cacheScope(module){const state=this.read();if(state.cacheLocked||state.networkSuspended)throw Error('账号已退出或身份发生变化，请重新验证后查看此账号的离线快照');if(state.moduleCacheLocks?.[module])throw Error('此模块的正式账本已更换，旧快照已锁定');if(!state.modulePins?.[module])throw Error('没有已核对的模块账本身份');return {...state.pins,moduleDataSetId:state.modulePins[module]};}
}
