import path from 'node:path';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fail} from './util.mjs';
import {CainiaoAuthorization} from './cainiao-auth.mjs';
import {collectorConnection,collectorChildEnvironment} from '../../../server/collector-browser-connection.mjs';
import {createOwnedTarget,closeOwnedTarget,ownedOperationCode,observeTransport} from '../../../server/collector-owned-page.mjs';
const require=createRequire(import.meta.url);

// Reload this fixed local adapter after source updates without discarding browser consent.
export {browserOperation} from './cainiao-page.mjs';

export class CainiaoBrowser{
 constructor(dir){if(process.env.LINGTU_WEB_COLLECTOR==='1'){const {CollectorBrowser}=require(path.resolve(import.meta.dirname,'../../../server/collector-client.mjs'));return new CollectorBrowser(dir);}this.dir=path.join(dir,'.cainiao-staging');fs.mkdirSync(this.dir,{recursive:true});this.authorization=new CainiaoAuthorization(dir);this.state={status:'disconnected',account:'',message:'连接已登录菜鸟的 Chrome'};this.client=null;this.connecting=null;this.generation=0;this.nativeShared=process.platform==='linux'&&process.env.LINGTU_SHARED_BROWSER==='1';this.ownedTarget=null;this.transportObserver=null;this.transport=null;}
 status(){return {...this.state,mode:process.platform==='linux'?'native':'extension',nativeShared:this.nativeShared,authorizationSaved:process.platform==='win32'&&this.authorization.has()};}
 async connect(){
  if(this.connecting)return this.connecting;const generation=++this.generation;this.state={status:'connecting',account:'',message:process.platform==='linux'?'正在连接菜鸟浏览器，请先在工作台“菜鸟登录”中完成登录':this.authorization.has()?'正在使用已保存的授权连接 Chrome':'请在 Chrome 的 Playwright 扩展页面确认连接，选择菜鸟金掌柜标签页'};
  this.connecting=(async()=>{let client;try{
   await this.disposeSession();if(generation!==this.generation)return this.status();
   const [{Client},{StdioClientTransport}]=await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'),import('@modelcontextprotocol/sdk/client/stdio.js')]);
   const connection=collectorConnection('overview');
   const cli=path.join(path.dirname(require.resolve('@playwright/mcp/package.json')),'cli.js');
   const token=connection.usesExtension?await this.authorization.load():'';if(generation!==this.generation)return this.status();
   if(this.nativeShared){this.ownedTarget=await createOwnedTarget(connection.args[1]);if(generation!==this.generation){await this.disposeSession();return this.status();}}
   const transport=new StdioClientTransport({command:process.execPath,args:[cli,...connection.args,'--output-dir',this.dir,'--output-max-size','1073741824','--snapshot-mode','none','--no-webmcp','--timeout-action','15000'],env:{...collectorChildEnvironment(),...(token?{PLAYWRIGHT_MCP_EXTENSION_TOKEN:token}:{})},cwd:path.resolve(import.meta.dirname,'..'),stderr:'pipe'});
   this.transport=transport;this.transportObserver=observeTransport(transport);
   transport.stderr?.on('data',()=>{});client=new Client({name:'灵兔云仓账单',version:'1.3.0'},{capabilities:{}});this.client=client;await client.connect(transport);
   // Automatic approval may attach the extension's connection page. Create a
   // normal blank tab through the official API; never inspect that internal page.
   if(token){const opened=await client.callTool({name:'browser_tabs',arguments:{action:'new'}},undefined,{timeout:60000});if(opened.isError)throw Error('已保存授权连接失败，请核对 Chrome 和扩展令牌');}
   if(generation!==this.generation)return this.status();
   const result=await this.run('account',{},600000);if(generation===this.generation)this.state={status:'connected',account:result.account,message:connection.usesExtension?'已连接日常 Chrome':this.nativeShared?'已连接共享菜鸟浏览器':'已连接 NAS 持久浏览器'};return this.status();
  }catch(e){let isolation;try{await this.disposeSession();}catch(error){isolation=error;}if(generation===this.generation)this.state={status:'error',account:'',message:humanError(isolation||e)};if(isolation||e.code==='BROWSER_ISOLATION_FAILED')throw isolation||e;return this.status();}finally{if(generation===this.generation)this.connecting=null;}})();return this.connecting;
 }
 async disposeSession(){
  if(this.disposing)return this.disposing;
  const client=this.client,observer=this.transportObserver,target=this.ownedTarget;this.client=null;this.transportObserver=null;this.transport=null;
  this.disposing=(async()=>{let error;try{if(observer)await observer.close(client);else await client?.close();}catch(e){error=e;}try{await closeOwnedTarget(target);if(this.ownedTarget===target)this.ownedTarget=null;}catch(e){error=e;}if(error)throw error;})();
  try{return await this.disposing;}finally{this.disposing=null;}
 }
 async disconnect(){this.generation++;const connecting=this.connecting;this.state={status:'disconnected',account:'',message:'浏览器已断开，已下载文件保留'};await this.disposeSession();await connecting?.catch(()=>{});await this.disposeSession();this.connecting=null;}
 async rememberAuthorization(token){await this.authorization.save(token);await this.disconnect();}
 async forgetAuthorization(){await this.disconnect();this.authorization.forget();}
 async run(op,args={},timeout=90000){
  if(!this.client)throw fail('请先连接 Chrome',409);
  const adapterPath=new URL('./cainiao-page.mjs',import.meta.url);
  const {browserOperation}=await import(adapterPath.href+'?revision='+fs.statSync(adapterPath).mtimeMs);
  const code=this.ownedTarget?ownedOperationCode(browserOperation,{op,...args},this.ownedTarget.targetId):`async (page) => { return await (${browserOperation.toString()})(page, ${JSON.stringify({op,...args})}); }`;
  let r;try{r=await this.client.callTool({name:'browser_run_code_unsafe',arguments:{code}},undefined,{timeout});}catch(e){if(this.nativeShared){await this.disposeSession();this.state={status:'error',account:'',message:humanError(e)};}throw e;}
  const text=(r.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');if(r.isError){const error=Error(text.slice(0,1500));if(this.nativeShared){await this.disposeSession();this.state={status:'error',account:'',message:humanError(error)};}throw error;}
  const part=text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1]?.trim();if(!part)throw Error('浏览器未返回有效结果');return JSON.parse(part);
 }
}
export function humanError(e){const text=String(e.message||e);if(/BROWSER_ISOLATION_FAILED/.test(text))return '当前采集页未能安全停止，已暂停共享浏览器采集，请重新启动应用后再连接。';if(/BROWSER_PAGE_CLOSED/.test(text))return '当前采集页已关闭，请重新连接；已下载文件保留。';if(process.platform==='linux'&&/ACCOUNT_CHANGED/.test(text))return '共享浏览器当前账号已变化，请切回任务账号后继续。';if(process.platform==='linux'&&/NEEDS_LOGIN/.test(text))return '菜鸟登录已失效，请在“菜鸟登录”中完成登录或验证后继续。';if(process.platform==='linux'&&/connect|timed out|timeout|closed|disconnected/i.test(text))return 'NAS 浏览器连接中断或操作等待超时，请在工作台“菜鸟登录”中检查当前采集页与登录状态后重连。';if(/extension|connect|timed out|timeout|closed|disconnected/i.test(text))return 'Chrome 连接中断或操作等待超时。请保持 Chrome 开启，重新连接并在扩展页面确认；已安装扩展无需重复安装。';return text.replace(/^### Error\s*/, '').slice(0,350);}
