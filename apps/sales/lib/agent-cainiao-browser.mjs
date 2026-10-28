import path from 'node:path';
import fs from 'node:fs';
import {createRequire} from 'node:module';


import {fail} from './util.mjs';
import {CainiaoAuthorization} from './agent-cainiao-auth.mjs';
const require=createRequire(import.meta.url);

// Reload this fixed local adapter after source updates without discarding browser consent.
export {browserOperation} from './agent-cainiao-page.mjs';

export class CainiaoBrowser{
 constructor(dir){this.dir=path.join(dir,'.cainiao-staging');fs.mkdirSync(this.dir,{recursive:true});this.authorization=new CainiaoAuthorization(dir);this.state={status:'disconnected',account:'',message:'连接已登录菜鸟的 Chrome'};this.client=null;this.connecting=null;this.generation=0;}
 status(){return {...this.state,authorizationSaved:this.authorization.has()};}
 async connect(){
  if(this.connecting)return this.connecting;const oldClient=this.client;this.client=null;const generation=++this.generation;this.state={status:'connecting',account:'',message:this.authorization.has()?'正在使用已保存的授权连接 Chrome':'请在 Chrome 的 Playwright 扩展页面确认连接，选择菜鸟金掌柜标签页'};
  this.connecting=(async()=>{let client;try{
   await oldClient?.close().catch(()=>{});if(generation!==this.generation)return this.status();
   const [{Client},{StdioClientTransport}]=await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'),import('@modelcontextprotocol/sdk/client/stdio.js')]);
   const cli=path.join(path.dirname(require.resolve('@playwright/mcp/package.json')),'cli.js');
   const token=await this.authorization.load();if(generation!==this.generation)return this.status();
   const transport=new StdioClientTransport({command:process.execPath,args:[cli,'--extension','--output-dir',this.dir,'--output-max-size','1073741824','--snapshot-mode','none','--no-webmcp','--timeout-action','15000'],...(token?{env:{PLAYWRIGHT_MCP_EXTENSION_TOKEN:token}}:{}),cwd:path.resolve(import.meta.dirname,'..'),stderr:'pipe'});
   transport.stderr?.on('data',()=>{});client=new Client({name:'灵兔云仓账单',version:'1.3.0'},{capabilities:{}});this.client=client;await client.connect(transport);
   // Automatic approval may attach the extension's connection page. Create a
   // normal blank tab through the official API; never inspect that internal page.
   if(token){const opened=await client.callTool({name:'browser_tabs',arguments:{action:'new'}},undefined,{timeout:60000});if(opened.isError)throw Error('已保存授权连接失败，请核对 Chrome 和扩展令牌');}
   if(generation!==this.generation)return this.status();
   const result=await this.run('account',{},600000);if(generation===this.generation)this.state={status:'connected',account:result.account,message:'已连接日常 Chrome'};return this.status();
  }catch(e){if(generation===this.generation){this.state={status:'error',account:'',message:humanError(e)};this.client=null;}await client?.close().catch(()=>{});return this.status();}finally{if(generation===this.generation)this.connecting=null;}})();return this.connecting;
 }
 async disconnect(){this.generation++;const client=this.client;this.client=null;this.connecting=null;this.state={status:'disconnected',account:'',message:'浏览器已断开，已下载文件保留'};await client?.close().catch(()=>{});}
 async rememberAuthorization(token){await this.authorization.save(token);await this.disconnect();}
 async forgetAuthorization(){await this.disconnect();this.authorization.forget();}
 async run(op,args={},timeout=90000){
  if(!this.client)throw fail('请先连接 Chrome',409);
  const adapterPath=new URL('./agent-cainiao-page.mjs',import.meta.url);
  const {browserOperation}=await import(adapterPath.href+'?revision='+fs.statSync(adapterPath).mtimeMs);
  const code=`async (page) => { return await (${browserOperation.toString()})(page, ${JSON.stringify({op,...args})}); }`;
  const r=await this.client.callTool({name:'browser_run_code_unsafe',arguments:{code}},undefined,{timeout});
  const text=(r.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');if(r.isError)throw Error(text.slice(0,1500));
  const part=text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1]?.trim();if(!part)throw Error('浏览器未返回有效结果');return JSON.parse(part);
 }
}
export function humanError(e){const text=String(e.message||e);if(/extension|connect|timed out|timeout|closed|disconnected/i.test(text))return 'Chrome 连接中断或操作等待超时。请保持 Chrome 开启，重新连接并在扩展页面确认；已安装扩展无需重复安装。';return text.replace(/^### Error\s*/, '').slice(0,350);}
