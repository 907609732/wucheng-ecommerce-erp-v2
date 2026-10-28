import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';

const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const workspace=fs.realpathSync(process.cwd());
const published=path.join(workspace,'dist','launcher-release','win-unpacked','resources','workbench-gateway');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-packaged-gateway-'));
const component=path.join(root,'component'),cwd=path.join(root,'run'),store=path.join(root,'store');
let child,closed=false,done=Promise.resolve(),stderr='';

try{
 assert(!inside(workspace,fs.realpathSync(root))&&!inside(fs.realpathSync(root),workspace),'打包验收临时目录必须位于工作区之外');
 assert(fs.existsSync(path.join(published,'package.json')),'请先构建启动台的 unpacked 发布包');
 // Never run the component below dist/: its ancestors include the developer's node_modules.
 fs.cpSync(published,component,{recursive:true,dereference:false,verbatimSymlinks:true});
 fs.mkdirSync(cwd);fs.mkdirSync(store);
 const required=['fastify','@fastify/reply-from','@fastify/cookie'];
 for(const name of required){const file=path.join(component,'node_modules',...name.split('/'),'package.json');assert(fs.existsSync(file),'发布组件缺少生产依赖：'+name);assert(inside(fs.realpathSync(component),fs.realpathSync(file)),'依赖通过链接越出发布组件：'+name);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).name,name);}

 // Use the installed managed runtime, with no fallback to the developer's system Node.
 const runtimeStateFile=process.env.GATEWAY_TEST_MODULE_STATE||path.join(process.env.APPDATA||os.homedir(),'wucheng-ecommerce-erp-v2','modules','installed.json');
 assert(fs.existsSync(runtimeStateFile),'未找到托管共享 Node 的 installed.json；本验收不回退系统 Node');
 const runtime=JSON.parse(fs.readFileSync(runtimeStateFile,'utf8')).packages?.['node-runtime'];
 assert(runtime?.id==='node-runtime'&&typeof runtime.root==='string'&&typeof runtime.entry==='string'&&typeof runtime.version==='string','托管共享 Node 登记不完整');
 const runtimeRoot=fs.realpathSync(runtime.root),registeredNode=fs.realpathSync(path.resolve(runtime.root,runtime.entry));
 assert(inside(runtimeRoot,registeredNode)&&registeredNode!==runtimeRoot,'共享 Node 入口越出托管运行环境');
 const node=process.env.GATEWAY_TEST_NODE?fs.realpathSync(process.env.GATEWAY_TEST_NODE):registeredNode;
 assert.equal(node.toLowerCase(),registeredNode.toLowerCase(),'GATEWAY_TEST_NODE 必须指向所登记的托管共享 Node');
 assert(!inside(workspace,runtimeRoot),'托管共享 Node 不能位于开发工作区中');

 // Keep only platform environment. Do not inherit NODE_PATH/NODE_OPTIONS, npm,
 // Electron, project, proxy-loader or workspace tool configuration.
 const platformEnvironment=/^(?:SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>platformEnvironment.test(name)));
 env.PATH=[path.dirname(node),...(process.env.SystemRoot?[path.join(process.env.SystemRoot,'System32'),process.env.SystemRoot]:['/usr/bin','/bin'])].join(path.delimiter);
 const registry=path.join(store,'registry.json');fs.writeFileSync(registry,'{}');env.LINGTU_REGISTRY_PATH=registry;
 fs.writeFileSync(path.join(store,'access-policy.json'),JSON.stringify({schemaVersion:1,users:{'fixture@example.test':{role:'admin',modules:[],canRunTasks:false,enabled:true}}}));

 // The probe itself runs in the copied component under managed Node. Check the
 // full declared production closure, then import the real gateway and inspect
 // every actually loaded CommonJS file; a developer ancestor cannot satisfy it.
 const probeFile=path.join(component,'.packaged-dependency-probe.mjs');
 fs.writeFileSync(probeFile,String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
import {pathToFileURL} from 'node:url';
const component=fs.realpathSync(process.argv[2]);
const inside=file=>{const relative=path.relative(component,fs.realpathSync(file));return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
assert(process.execArgv.includes('--no-global-search-paths'));
assert(!Object.keys(process.env).some(name=>/^(?:NODE_|NPM_|TS_NODE_|ELECTRON_)/i.test(name)),'继承了开发运行环境');
assert.equal(process.version,'v'+process.argv[3],'托管 Node 可执行文件版本与登记不符');
assert.equal(fs.realpathSync(process.execPath).toLowerCase(),fs.realpathSync(process.argv[4]).toLowerCase());
const visited=new Set(),optionalMissing=[];
function packageRoot(entry,name){let folder=path.dirname(entry);while(inside(folder)){const file=path.join(folder,'package.json');if(fs.existsSync(file)){const pkg=JSON.parse(fs.readFileSync(file,'utf8'));if(pkg.name===name)return folder;}const parent=path.dirname(folder);if(parent===folder)break;folder=parent;}throw Error('无法定位组件内依赖清单：'+name);}
function visit(folder){folder=fs.realpathSync(folder);assert(inside(folder),'生产依赖越出组件：'+folder);if(visited.has(folder))return;visited.add(folder);const file=path.join(folder,'package.json'),pkg=JSON.parse(fs.readFileSync(file,'utf8')),require=createRequire(file);
 const optional=pkg.optionalDependencies||{},peers=pkg.peerDependencies||{};
 const all={...pkg.dependencies,...optional,...peers};
 for(const name of Object.keys(all)){if(isBuiltin(name))continue;const mayBeAbsent=Object.hasOwn(optional,name)||Object.hasOwn(peers,name)&&pkg.peerDependenciesMeta?.[name]?.optional===true;let entry;try{entry=require.resolve(name);}catch(error){if(mayBeAbsent){optionalMissing.push(name);continue;}throw Error('生产依赖无法解析：'+pkg.name+' -> '+name+' ('+error.code+')');}assert(inside(entry),'生产依赖从组件外解析：'+pkg.name+' -> '+name+' -> '+entry);visit(packageRoot(fs.realpathSync(entry),name));}
}
visit(component);
await import(pathToFileURL(path.join(component,'desktop','workbench','gateway.mjs')).href);
const require=createRequire(import.meta.url),loaded=Object.keys(require.cache);for(const file of loaded)assert(inside(file),'实际加载了组件外的模块：'+file);
console.log(JSON.stringify({ok:true,resolvedPackages:visited.size-1,loadedModules:loaded.length,allProductionDependenciesInsideComponent:true,allLoadedModulesInsideComponent:true,managedNodeVersion:process.version,optionalMissing:[...new Set(optionalMissing)].sort()}));
`);
 // Negative control: ordinary Node ancestor lookup still exists even with its
 // global paths disabled. An ambient package must never rescue a missing file
 // in the copied release. Modify only this disposable copy, then restore it.
 const copiedCookie=path.join(component,'node_modules','@fastify','cookie'),savedCookie=copiedCookie+'.isolated-check',ambientCookie=path.join(root,'node_modules','@fastify','cookie');
 fs.mkdirSync(ambientCookie,{recursive:true});fs.writeFileSync(path.join(ambientCookie,'package.json'),JSON.stringify({name:'@fastify/cookie',version:'0.0.0-ambient-trap',main:'index.cjs'}));fs.writeFileSync(path.join(ambientCookie,'index.cjs'),'module.exports = {};');
 fs.renameSync(copiedCookie,savedCookie);
 try{const escaped=spawnSync(node,['--no-global-search-paths',probeFile,component,runtime.version,node],{cwd,env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert.notEqual(escaped.status,0,'组件缺失依赖时错误地通过祖先包验收');assert.match(escaped.stderr,/生产依赖从组件外解析/,'负对照未验证祖先依赖逃逸');}finally{fs.renameSync(savedCookie,copiedCookie);}
 const checked=spawnSync(node,['--no-global-search-paths',probeFile,component,runtime.version,node],{cwd,env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
 assert.equal(checked.status,0,checked.stderr||checked.error?.message||'组件生产依赖闭包检查失败');
 const closure=JSON.parse(checked.stdout.trim());assert.equal(closure.ok,true);assert(closure.resolvedPackages>=required.length);assert(closure.loadedModules>0);

 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 child=spawn(node,['--no-global-search-paths',path.join(component,'desktop','workbench-migration','server-entry.mjs'),'--store-dir',store,'--origin','https://fixture.test-tail.ts.net:8443','--port',String(port)],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();done=once(child,'exit').then(()=>{closed=true;},error=>{closed=true;stderr+=error.message;});
 let health;for(let i=0;i<100;i++){if(closed)throw Error(stderr||'发布组件网关提前退出');try{const r=await fetch('http://127.0.0.1:'+port+'/api/workbench/v1/health',{signal:AbortSignal.timeout(1000)});if(r.ok){health=await r.json();break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(health?.protocolVersion,1,stderr);assert.ok(health.serverId);assert.ok(health.dataSetId);
 const headers={host:'fixture.test-tail.ts.net:8443','tailscale-user-login':'fixture@example.test'};
 const response=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/api/workbench/v1/session',headers},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(body)});}catch(error){reject(error);}});});req.on('error',reject);});
 assert.equal(response.status,200);assert.deepEqual(response.data.modules,[]);assert.equal(response.data.serverId,health.serverId);assert(!fs.existsSync(path.join(store,'purchase','purchases.sqlite')));
 console.log(JSON.stringify({ok:true,packagedGateway:true,componentCopiedOutsideWorkspace:true,managedSharedNode:closure.managedNodeVersion,isolatedCwd:true,isolatedStore:true,inheritedNodeEnvironmentCleared:true,globalModuleSearchDisabled:true,ancestorFallbackRejected:true,resolvedProductionPackages:closure.resolvedPackages,loadedComponentModules:closure.loadedModules,allDependenciesInsideCopiedComponent:true,noBusinessModuleStarted:true}));
}finally{if(child&&!closed)child.kill();await done;fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
