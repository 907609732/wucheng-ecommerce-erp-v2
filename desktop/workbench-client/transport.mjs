import crypto from 'node:crypto';
import {MODULE_IDS,serverAddress} from './connection.mjs';
const API='/api/workbench/v1';
export class WorkbenchTransport{
  constructor({connection,fetchImpl=fetch,channel='ui',cache}){Object.assign(this,{connection,fetchImpl,channel,cache});this.configuration=connection.read();this.identity=null;this.cookies='';this.moduleConnections=new Map();}
  async request(route,{method='GET',body,rawBody,headers={},migration=false}={}){
    this.connection.assertConfiguration(this.configuration);
    const state=this.connection.read();if(!['client','server'].includes(state.mode))throw Error('当前未使用服务器连接');
    if(state.networkSuspended)throw Object.assign(Error('已暂停私网连接，请在设置中重新连接或登录'),{code:'TAILNET_SUSPENDED'});
    if(!route.startsWith('/')||route.includes('..')||/[\\#\r\n]/.test(route))throw Error('接口路径无效');
    if(!['GET','HEAD'].includes(method)&&!migration&&!this.connection.canWrite())throw Object.assign(Error('本机旧账本尚未完成迁移核对，当前只允许查询'),{code:'MIGRATION_REQUIRED'});
    if(route!=='/session'&&!this.identity)await this.connect();
    this.connection.assertConfiguration(state);
    const origin=serverAddress(state.serverUrl),mutating=!['GET','HEAD'].includes(method);
    const startingModule=/^\/modules\/(warehouse|purchase|sales|overview|exporter)\/connection$/.test(route);
    if(mutating&&!this.identity)await this.connect();
    this.connection.assertConfiguration(state);
    const response=await this.fetchImpl(origin+API+route,{method,redirect:'error',credentials:'include',headers:{...headers,Origin:origin,'X-Workbench-Channel':this.channel,...(this.cookies?{Cookie:this.cookies}:{}),...(mutating?{'X-Workbench-CSRF':this.identity?.csrfToken||'', 'Idempotency-Key':headers['Idempotency-Key']||crypto.randomUUID()}:{}),...(rawBody!==undefined?{'Content-Type':'application/octet-stream'}:body!==undefined?{'Content-Type':'application/json'}:{})},...(rawBody!==undefined?{body:rawBody}:body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(migration?180000:startingModule?120000:30000)}).catch(error=>{
      if(/^(?:TAILNET_|EMBEDDED_)/.test(error.code||''))throw error;
      const detail=String(error.cause?.code||error.code||error.message||'');
      if(/CERT|SSL|TLS/i.test(detail))throw Object.assign(Error('服务器证书验证失败，请核对 Tailscale 地址'),{code:'TLS_INVALID'});
      throw Object.assign(Error('主服务器暂不可用：'+detail),{code:'SERVER_UNAVAILABLE'});
    });
    const cookie=response.headers.getSetCookie?.()||[];if(cookie.length)this.cookies=cookie.map(v=>v.split(';')[0]).join('; ');
    const contentType=response.headers.get('content-type')||'';
    if(!contentType.includes('application/json'))throw Object.assign(Error('服务器返回了无法识别的页面，请核对 Tailscale 地址'),{code:'SERVER_RESPONSE_INVALID'});
    const result=await response.json();this.connection.assertConfiguration(state);
    if(!response.ok){
      const error=Error(result.message||result.error||'服务器请求失败');error.code=result.code||({401:'IDENTITY_REQUIRED',403:'PERMISSION_DENIED',409:'REVISION_CONFLICT',503:'SERVER_UNAVAILABLE'}[response.status])||'REQUEST_FAILED';error.status=response.status;
      if(error.code==='DATASET_CHANGED'){
        const module=/^\/modules\/(warehouse|purchase|sales|overview|exporter)(?:\/|$)/.exec(route)?.[1];
        this.connection.lockCache(module);this.identity=null;this.cookies='';this.moduleConnections.clear();
      }
      throw error;
    }
    return result;
  }
  async connect(){
    const expected=this.connection.read();
    const result=await this.request('/session');
    if(result.protocolVersion!==1)throw Object.assign(Error('工作台接口版本不兼容'),{code:'VERSION_INCOMPATIBLE'});
    const actor=result.actor||result.identity;this.connection.bind({serverId:result.serverId,dataSetId:result.dataSetId,userId:actor?.id||actor?.userId||actor?.login},expected);
    this.identity={...result,actor};return this.identity;
  }
  async modules(){if(!this.identity)await this.connect();const result=await this.request('/modules');return Array.isArray(result)?result:result.modules;}
  async call(id,path,options={}){
    const expected=this.connection.read();
    if(!MODULE_IDS.includes(id)||!path.startsWith('/'))throw Error('未知模块接口');
    if(!['GET','HEAD'].includes(options.method||'GET')&&!this.connection.canWrite())throw Object.assign(Error('本机旧账本尚未完成迁移核对，当前只允许查询'),{code:'MIGRATION_REQUIRED'});
    if(this.channel!=='ui'&&/\/(?:confirm|commit|rollback)(?:[/?-]|$)/i.test(path))throw Object.assign(Error('正式确认必须在页面完成，CLI/MCP 只能整理草稿'),{code:'UI_CONFIRMATION_REQUIRED'});
    if(!this.moduleConnections.has(id))this.moduleConnections.set(id,this.request('/modules/'+id+'/connection').then(cap=>{this.connection.bindModule(id,cap.dataSetId,expected);return cap;}).catch(error=>{this.moduleConnections.delete(id);throw error;}));
    await this.moduleConnections.get(id);
    this.connection.assertConfiguration(expected);
    return this.request('/modules/'+id+path,options);
  }
  async snapshot(id){
    const routes={warehouse:'/api/integration/v1/workbench/inventory',purchase:'/api/orders',sales:'/api/integration/v1/ledger',overview:'/api/dashboard',exporter:'/api/integration/v1/workbench/state'};
    let data;
    if(id==='sales'){
      const boot=await this.call(id,'/api/bootstrap');if(!/^\d{4}-\d{2}$/.test(boot.month||''))throw Error('销售台未返回有效账期');
      const query='?month='+boot.month;
      data={month:boot.month,ledger:await this.call(id,'/api/integration/v1/ledger'+query),report:await this.call(id,'/api/integration/v1/report'+query)};
    }else data=await this.call(id,routes[id]);
    if(id==='purchase'&&Array.isArray(data))data=data.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,1000);
    await this.cache?.put(this.connection.cacheScope(id),id,data);return data;
  }
}
export class RemoteServiceManager{
  constructor(transport){this.transport=transport;}
  async status(){return this.transport.modules();}
  async ensure(id){
    const expected=this.transport.connection.read();
    const rows=await this.transport.modules();let row=rows.find(r=>r.id===id||r.extension===id);
    if(!row||['missing','unavailable','incompatible'].includes(row.status)||row.installed===false||row.authorized===false)throw Object.assign(Error('服务器未接入兼容的模块或你没有访问权限，请联系管理员'),{code:'MODULE_UNAVAILABLE'});
    if(row.status!=='running'||!row.dataSetId)row={...row,...await this.transport.request('/modules/'+id+'/connection')};
    this.transport.connection.bindModule(id,row.dataSetId,expected);
    return {...row,url:this.transport.connection.read().serverUrl+'/apps/'+id,remote:true};
  }
  async request(id,route,options){return this.transport.call(id,'/api/integration/v1'+route,options);}
  async business(id,route){return this.transport.call(id,route);}
  stop(){throw Error('客户端不能停止主服务器后台，请在主机设置中操作');}
  config(){throw Error('客户端不能访问主服务器磁盘路径');}
}
