// Synthetic acceptance only. Never pass a real instance data root to this tool.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {verifySandboxResult,mcpEvaluationResult,isAllowedRuntimeLibrary} from './smoke-checks.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
const app=fs.realpathSync(args['app-root']),release=path.join(app,'erp'),runtime=path.join(app,'runtime');
const data=path.resolve(args['data-root']),evidence=path.resolve(args['evidence-dir']),offset=Number(args['port-offset']||0),diagnostic=args.diagnostic==='1';
assert(process.platform==='linux'&&process.getuid()!==0,'Run as a dedicated non-root package user');
assert(!fs.existsSync(data),'Synthetic data root must not already exist');
assert(Number.isInteger(offset)&&offset>=0&&offset<=10000&&offset%100===0);
fs.mkdirSync(evidence,{recursive:true});
const {configureNative}=await import(pathToFileURL(path.join(release,'server/fnos-native/configure.mjs')));
const {nativeLifecycle}=await import(pathToFileURL(path.join(release,'server/fnos-native/lifecycle.mjs')));
const {collectorChildEnvironment}=await import(pathToFileURL(path.join(release,'server/collector-browser-connection.mjs')));
const {databases,loadConfig,developmentConfig,validateConfig}=await import(pathToFileURL(path.join(release,'server/config.mjs')));
const require=createRequire(path.join(release,'apps/sales/package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
// The pinned core entry is CommonJS with computed exports; use its public CJS
// API rather than assuming Node synthesizes named ESM exports for it.
const {chromium}=require('playwright-core');
const report={ok:false,uid:process.getuid(),node:process.version,sqlite:false,sandbox:false,checks:[],ports:{sales:19222+offset,overview:19223+offset},scope:'Synthetic Linux CI / isolated device fixture; does not prove production NAS installation'};
const fixture=http.createServer((req,res)=>{
 if(req.url==='/download'){res.writeHead(200,{'content-type':'text/plain','content-disposition':'attachment; filename="native-acceptance.txt"'});res.end('native FPK download acceptance\n');return;}
 if(req.url?.startsWith('/novnc/')){
  const p=path.resolve(runtime,'novnc',decodeURIComponent(req.url.slice(7).split('?')[0]));
  if(!p.startsWith(path.join(runtime,'novnc')+path.sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('content-type',p.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(p));}catch{res.writeHead(404);res.end();}return;
 }
 res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html><head><title>Native acceptance</title></head><body><h1>五成 ERP 原生验收</h1><label>Acceptance input <input aria-label="Acceptance input"></label><a href="/download" download>Download fixture</a><p id="status">Synthetic local fixture</p></body></html>');
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+fixture.address().port;
let configFile,client,transport,browser,viewerBrowser,initializingServices;
let interrupting=false;
async function interrupt(){
 if(interrupting)return;interrupting=true;report.error='Acceptance cancelled by signal';report.ok=false;
 const hard=setTimeout(()=>process.exit(124),40000);
 await initializingServices?.stopOwned().catch(()=>{});
 await stopClients().catch(()=>{});
 if(configFile)await nativeLifecycle('stop',configFile).catch(e=>{report.cleanupError=e.message;});
 fixture.closeAllConnections();await new Promise(r=>fixture.close(r));
 fs.writeFileSync(path.join(evidence,'acceptance.json'),JSON.stringify(report,null,2)+'\n');clearTimeout(hard);process.exit(124);
}
process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt);
async function connect(port){
 const c=new Client({name:'native-fpk-acceptance',version:'1.0.0'},{capabilities:{}});
 const tr=new StdioClientTransport({command:process.execPath,args:[path.join(release,'apps/sales/node_modules/@playwright/mcp/cli.js'),'--cdp-endpoint','http://127.0.0.1:'+port,'--output-dir',evidence,'--timeout-navigation','30000'],env:collectorChildEnvironment(),cwd:evidence,stderr:'pipe'});
 tr.stderr?.on('data',b=>fs.appendFileSync(path.join(evidence,'mcp.stderr.log'),b));await c.connect(tr);
 const tools=await c.listTools();fs.writeFileSync(path.join(evidence,'mcp-tool-schemas.json'),JSON.stringify(tools.tools.filter(t=>['browser_navigate','browser_type','browser_click','browser_evaluate','browser_snapshot'].includes(t.name)),null,2)+'\n');return {client:c,transport:tr};
}
async function tool(name,arguments_={}){
 const r=await client.callTool({name,arguments:arguments_});const text=r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'';
 fs.appendFileSync(path.join(evidence,'mcp.log'),name+'\n'+text+'\n');if(r.isError)throw Error(name+': '+text);return text;
}
const ref=(snapshot,pattern)=>{const line=snapshot.split('\n').find(l=>pattern.test(l)),r=line?.match(/\[ref=([^\]]+)\]/)?.[1];assert(r,'Missing MCP reference: '+pattern+'\n'+snapshot);return r;};
async function stopClients(){await client?.close();await transport?.close();client=null;transport=null;await browser?.close();browser=null;await viewerBrowser?.close();viewerBrowser=null;}
function auditLoadedLibraries(){
 const procs=new Map(),observed=[],unreadable=[],unexpected=[];
 for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)))try{
  const stat=fs.statSync('/proc/'+name),text=fs.readFileSync('/proc/'+name+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');
  procs.set(Number(name),{parent:Number(fields[1]),uid:stat.uid});
 }catch{}
 for(const [pid,p] of procs){
  if(p.uid!==process.getuid())continue;let ancestor=pid;const seen=new Set();
  while(ancestor!==process.pid&&procs.has(ancestor)&&!seen.has(ancestor)){seen.add(ancestor);ancestor=procs.get(ancestor).parent;}
  if(ancestor!==process.pid)continue;
  let maps;try{maps=fs.readFileSync('/proc/'+pid+'/maps','utf8');}catch(e){if(e.code==='EACCES'||e.code==='EPERM'){unreadable.push({pid,reason:'sandbox process denies package-user maps access'});continue;}if(e.code==='ENOENT')continue;throw e;}
  const libs=[...new Set(maps.split('\n').map(l=>l.trim().split(/\s+/).slice(5).join(' ').replace(/ \(deleted\)$/,'')).filter(f=>f.startsWith('/')&&(/\.so(?:\.|$)/.test(f)||path.basename(f).startsWith('ld-linux'))))];
  for(const file of libs){
   if(!isAllowedRuntimeLibrary(file,runtime,release))unexpected.push({pid,file});
  }
  let exe;try{exe=fs.readlinkSync('/proc/'+pid+'/exe');}catch(e){if(!['ENOENT','EACCES','EPERM'].includes(e.code))throw e;exe='unavailable: '+e.code;}
  observed.push({pid,exe,libraries:libs});
 }
 assert(observed.length>0,'No controlled process library maps inspected');
 const result={observed,unreadable,unexpected,hostException:'glibc 2.36 loader/family and glibc gconv only'};
 fs.writeFileSync(path.join(evidence,'loaded-libraries.json'),JSON.stringify(result,null,2)+'\n');assert.equal(unexpected.length,0,'Non-payload controlled-process libraries: '+JSON.stringify(unexpected));return {readableProcesses:observed.length,sandboxMapsDenied:unreadable.length};
}
try{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE check_native(v TEXT)');db.prepare('INSERT INTO check_native VALUES (?)').run('ok');assert.equal(db.prepare('SELECT v FROM check_native').get().v,'ok');db.close();report.sqlite=true;
 const browserConfig={enabled:true,runtimeRoot:runtime,chromiumPath:path.join(runtime,'chromium/chrome'),novncRoot:path.join(runtime,'novnc'),instances:{sales:{cdpPort:19222+offset,vncPort:19322+offset,display:122+offset/100},overview:{cdpPort:19223+offset,vncPort:19323+offset,display:123+offset/100}}};
 if(diagnostic){
  // Build a synthetic production config without calling the main app's fixed
  // configureNative/native_env contracts or touching their directories.
  fs.mkdirSync(data,{mode:0o700});const state=path.join(data,'state');fs.mkdirSync(state,{mode:0o700});
  const c=developmentConfig({root:release,stateDir:state,port:29430});
  for(const [id,m] of Object.entries(c.modules)){m.dataDir=path.join(data,'data',id);}
  const {createSourceServices}=await import(pathToFileURL(path.join(release,'server/services.mjs')));
  const services=initializingServices=await createSourceServices(c);try{for(const id of Object.keys(c.modules)){assert(!interrupting,'acceptance cancelled');await services.ensure(id);}}finally{await services.stopOwned();initializingServices=null;}
  c.mode='production';c.releaseRoot=release;c.tcpEnabled=true;c.fnos={enabled:false};c.publicOrigin='https://native-acceptance.example.com';c.dataVersion={enabled:false};
  c.native={dataRoot:data,home:path.join(data,'uvcs-home'),nodePath:process.execPath,requireBrowsers:true,browser:browserConfig};fs.mkdirSync(c.native.home,{mode:0o700});
  fs.mkdirSync(path.join(data,'config'),{mode:0o700});configFile=path.join(data,'config/web.json');fs.writeFileSync(configFile,JSON.stringify(validateConfig(c)),{mode:0o600});
 }else configFile=await configureNative({releaseRoot:release,dataRoot:data,mode:'fresh',publicOrigin:'https://native-acceptance.example.com',allowedUids:['23001'],allowedOrigins:['https://native-acceptance.example.com'],socketPath:path.join(app,'app.sock'),requireBrowsers:true,browser:browserConfig});
 const c=loadConfig(configFile);c.port=diagnostic?29430:28430+offset;
 for(const [i,m] of Object.values(c.modules).entries()){m.port=c.port+i+1;if(m.mobilePort)m.mobilePort=c.port+4;}
 fs.writeFileSync(configFile,JSON.stringify(c));
 const first=await nativeLifecycle('start',configFile);assert(first.ok&&first.browser.ready);report.checks.push('fresh lifecycle with two browsers and real collector');
 const identity={serverId:first.serverId,dataSetId:first.dataSetId};
 if(diagnostic){assert.equal((await fetch('http://127.0.0.1:'+c.port+'/api/workbench/v1/health')).status,200);report.checks.push('synthetic loopback-only TCP / fnOS disabled / UVCS disabled');}
 else{assert.equal((fs.statSync(path.join(app,'app.sock')).mode&0o777),0o600);await assert.rejects(fetch('http://127.0.0.1:'+c.port+'/api/workbench/v1/health',{signal:AbortSignal.timeout(1000)}));report.checks.push('Unix-only gateway / no TCP gateway');}
 ({client,transport}=await connect(19222+offset));
 await tool('browser_navigate',{url:'chrome://sandbox/'});
 const sandbox=await tool('browser_evaluate',{function:'() => document.body.innerText'});
 fs.writeFileSync(path.join(evidence,'chromium-sandbox.txt'),sandbox);
 report.sandboxStatus=verifySandboxResult(sandbox);report.sandbox=true;
 await tool('browser_navigate',{url:'https://example.com/'});assert.match(await tool('browser_snapshot'),/Example Domain/);report.checks.push('HTTPS CA/NSS navigation');
 await tool('browser_navigate',{url});let snapshot=await tool('browser_snapshot');assert.match(snapshot,/五成 ERP 原生验收/);
 await tool('browser_type',{target:ref(snapshot,/textbox "Acceptance input"/),text:'MCP input verified'});
 snapshot=await tool('browser_snapshot');assert.match(snapshot,/MCP input verified/);report.checks.push('pinned Playwright MCP navigation / snapshot / input');
 await tool('browser_evaluate',{function:'() => { document.cookie="native_acceptance=retained; max-age=3600; path=/"; localStorage.setItem("native_acceptance","retained"); return document.cookie; }'});
 snapshot=await tool('browser_snapshot');await tool('browser_click',{target:ref(snapshot,/link "Download fixture"/)});
 function findDownload(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){const found=findDownload(p);if(found)return found;}else if(e.name==='native-acceptance.txt')return p;}}
 // Pinned upstream MCP attaches with noDefaults:true, deliberately preserving
 // Chromium's default download directory and not enabling Playwright download
 // events. Look only inside this newly created synthetic data root, whose HOME
 // is also the managed Chromium HOME; never inspect the user's Downloads.
 const until=Date.now()+10000;let downloaded;while(!(downloaded=findDownload(evidence)||findDownload(data))&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
 assert(downloaded,'MCP-triggered Chromium download file missing');assert.equal(fs.readFileSync(downloaded,'utf8'),'native FPK download acceptance\n');report.download={filename:path.basename(downloaded),relativeSyntheticPath:path.relative(data,downloaded),bytes:fs.statSync(downloaded).size,sha256:createHash('sha256').update(fs.readFileSync(downloaded)).digest('hex'),connection:'upstream MCP CDP noDefaults / Chromium default download'};fs.copyFileSync(downloaded,path.join(evidence,'download-verified.txt'));report.checks.push('MCP click / real Chromium default download contents');
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+(19222+offset));
 const page=browser.contexts()[0].pages().find(p=>p.url()===url+'/');assert(page);
 await page.screenshot({path:path.join(evidence,'synthetic-browser.png')});
 const bounds=await page.locator('input').evaluate(e=>{const r=e.getBoundingClientRect();return {x:window.screenX+r.x+r.width/2,y:window.screenY+r.y+r.height/2,top:window.outerHeight-window.innerHeight};});
 viewerBrowser=await chromium.connectOverCDP('http://127.0.0.1:'+(19223+offset));const viewer=await viewerBrowser.contexts()[0].newPage();await viewer.goto(url);
 await viewer.evaluate(async vnc=>{document.body.innerHTML='<div id="screen" style="width:1440px;height:900px"></div>';document.body.style.margin='0';const {default:RFB}=await import('/novnc/core/rfb.js');window.rfb=new RFB(document.querySelector('#screen'),'ws://127.0.0.1:'+vnc+'/websockify',{shared:true});window.rfb.scaleViewport=false;await new Promise((resolve,reject)=>{window.rfb.addEventListener('connect',resolve,{once:true});window.rfb.addEventListener('disconnect',()=>reject(Error('RFB disconnected')),{once:true});setTimeout(()=>reject(Error('RFB timeout')),10000);});},19322+offset);
 const canvas=viewer.locator('canvas');await canvas.waitFor();await viewer.waitForTimeout(500);
 await canvas.click({position:{x:bounds.x,y:bounds.y+bounds.top}});await viewer.keyboard.type(' RFB');
 await page.waitForFunction(()=>document.querySelector('input').value.includes('RFB'));await viewer.screenshot({path:path.join(evidence,'novnc-live.png')});
 report.checks.push('upstream noVNC real RFB framebuffer / pointer / keyboard via x11vnc');
 report.loadedLibraries=auditLoadedLibraries();report.checks.push('readable controlled-process maps limited to payload and host glibc');
 const profileRoot=path.join(data,'browser-profiles/sales'),cookie=(await page.context().cookies(url)).find(c=>c.name==='native_acceptance');
 assert.equal(cookie?.value,'retained');assert(cookie.expires>Date.now()/1000+3000,'Synthetic cookie must have a future persistent expiry');
 report.persistenceBefore={cookieExpires:cookie.expires,cookieValue:cookie.value,storage:await page.evaluate(()=>localStorage.getItem('native_acceptance')),profileRealpath:fs.realpathSync(profileRoot),lastVersion:fs.existsSync(path.join(profileRoot,'Last Version'))?fs.readFileSync(path.join(profileRoot,'Last Version'),'utf8'):null};assert.equal(report.persistenceBefore.storage,'retained');
 await stopClients();await nativeLifecycle('stop',configFile);assert.equal((await nativeLifecycle('status',configFile)).status,'stopped');
 assert(fs.existsSync(profileRoot));assert.equal(fs.readdirSync(path.dirname(profileRoot)).filter(n=>n.startsWith('sales.retained-')).length,0,'Unexpected profile archive');
 const second=await nativeLifecycle('start',configFile);assert.notEqual(second.generation,first.generation);assert.equal(second.serverId,identity.serverId);assert.equal(second.dataSetId,identity.dataSetId);
 assert.equal(second.browser.browsers.sales.retainedProfile,null);assert.equal(fs.realpathSync(profileRoot),report.persistenceBefore.profileRealpath);
 ({client,transport}=await connect(19222+offset));await tool('browser_navigate',{url});const retained=mcpEvaluationResult(await tool('browser_evaluate',{function:'() => ({cookie:document.cookie,storage:localStorage.getItem("native_acceptance")})'}));report.persistenceAfter=retained;assert.match(retained.cookie,/native_acceptance=retained/);assert.equal(retained.storage,'retained');
 report.checks.push('restart generation / ledger identity / persistent synthetic browser session');
 await stopClients();await nativeLifecycle('stop',configFile);assert.equal((await nativeLifecycle('status',configFile)).status,'stopped');
 for(const [id,m] of Object.entries(c.modules)){const d=new DatabaseSync(path.join(m.dataDir,databases[id]),{readOnly:true});assert.equal(Object.values(d.prepare('PRAGMA integrity_check').get())[0],'ok');d.close();}
 report.checks.push('stop cleanup and three real SQLite integrity checks');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error.stack);
 if(configFile){const log=path.join(data,'state/native-supervisor.log');if(fs.existsSync(log)){fs.copyFileSync(log,path.join(evidence,'native-supervisor.log'));console.error(fs.readFileSync(log,'utf8').slice(-12000));}}
}finally{
 await stopClients().catch(()=>{});if(configFile)await nativeLifecycle('stop',configFile).catch(e=>{report.cleanupError=e.message;process.exitCode=1;});
 await new Promise(r=>fixture.close(r));fs.writeFileSync(path.join(evidence,'acceptance.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
