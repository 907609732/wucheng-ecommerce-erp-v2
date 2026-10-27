// Executed only by the packaged Electron in RUN_AS_NODE mode. This probe never
// sends start/login and uses an OS temporary profile, not the user's account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire,isBuiltin} from 'node:module';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [archive,resource,temporary]=process.argv.slice(2).map(file=>path.resolve(file));
const inside=file=>{const relative=path.relative(archive,fs.realpathSync(file));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
assert(process.execArgv.includes('--no-global-search-paths'));
assert(!Object.keys(process.env).some(key=>/^NODE_|^NPM_|^TS_|^TSNET_/i.test(key)));
assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');
const entry=path.join(archive,'desktop/workbench-client/tailnet-broker.mjs'),require=createRequire(entry),visited=new Set(),optionalMissing=[];
const developmentDirectories=new Set(['test','tests','__tests__','example','examples','benchmark','benchmarks']);
function checkProductionTree(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(entry.isDirectory()){assert(!developmentDirectories.has(entry.name),'Development fixture directory in packaged dependencies: '+entry.name);checkProductionTree(path.join(folder,entry.name));}}}
if(fs.existsSync(path.join(archive,'node_modules')))checkProductionTree(path.join(archive,'node_modules'));
function packageRoot(entry,name){let folder=path.dirname(entry);while(inside(folder)){const file=path.join(folder,'package.json');if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8')).name===name)return folder;const parent=path.dirname(folder);if(parent===folder)break;folder=parent;}throw Error('Broker dependency manifest not inside ASAR: '+name);}
function visit(folder){folder=fs.realpathSync(folder);assert(inside(folder),'Broker dependency outside ASAR');if(visited.has(folder))return;visited.add(folder);const file=path.join(folder,'package.json'),pkg=JSON.parse(fs.readFileSync(file,'utf8')),local=createRequire(file),optional=pkg.optionalDependencies||{},peers=pkg.peerDependencies||{};
 for(const name of Object.keys({...pkg.dependencies,...optional,...peers})){if(isBuiltin(name))continue;let resolved;try{resolved=local.resolve(name);}catch(error){if(Object.hasOwn(optional,name)||Object.hasOwn(peers,name)&&pkg.peerDependenciesMeta?.[name]?.optional){optionalMissing.push(name);continue;}throw Error('Broker dependency missing: '+pkg.name+' -> '+name+' ('+error.code+')');}assert(inside(resolved),'Broker dependency resolved outside ASAR: '+name);visit(packageRoot(resolved,name));}
}
const fastify=require.resolve('fastify');assert(inside(fastify),'Broker fastify resolved outside ASAR');visit(packageRoot(fastify,'fastify'));
const {createTailnetBroker}=await import(pathToFileURL(entry).href);
const {tailnetPaths}=await import(pathToFileURL(path.join(archive,'desktop/workbench-client/tailnet-runtime.mjs')).href);
assert.equal(typeof (await import(pathToFileURL(path.join(archive,'desktop/workbench-client/tailnet-broker-entry.mjs')).href)).runTailnetBrokerEntry,'function');
for(const file of Object.keys(require.cache))assert(inside(file),'Loaded broker dependency outside ASAR: '+file);

const profile=path.join(temporary,'profile');fs.mkdirSync(profile);
const origin='https://workbench.synthetic-tail.ts.net:8443',paths=tailnetPaths(profile,origin);fs.mkdirSync(paths.directory,{recursive:true});
const init={v:1,profile,origin,brokerId:randomUUID(),controlToken:randomBytes(32).toString('hex'),proxyPassword:randomBytes(32).toString('hex'),nonce:randomBytes(32).toString('hex'),sidecarPath:path.join(resource,'lingtu-tailnet.exe')};
let broker;
function request(route,{authorized=false,method='GET',originHeader=false}={}){return new Promise((resolve,reject)=>{const url=new URL(broker.url+route),request=http.request(url,{method,agent:false,headers:{Accept:'application/json',...(authorized?{Authorization:'Bearer '+init.controlToken}:{}),...(originHeader?{Origin:'https://example.invalid'}:{}),...(method==='POST'?{'Content-Type':'application/json','Content-Length':'2'}:{})}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(body)});}catch(error){reject(error);}});});request.once('error',reject);request.setTimeout(15000,()=>request.destroy(Error('inert broker probe timed out')));request.end(method==='POST'?'{}':undefined);});}
try{
 broker=await createTailnetBroker(init);
 const challenge=randomBytes(32).toString('hex'),proof=await request('/proof?challenge='+challenge);
 assert.equal(proof.status,200);assert(proof.body.mac===createHmac('sha256',init.controlToken).update(challenge).digest('hex'),'Broker identity proof mismatch');
 assert.equal((await request('/rpc/status',{method:'POST'})).status,401);
 assert.equal((await request('/rpc/status',{method:'POST',authorized:true,originHeader:true})).status,403);
 const status=await request('/rpc/status',{method:'POST',authorized:true});assert.equal(status.status,200);assert.equal(status.body.result.state,'stopped');assert.equal(status.body.result.origin,origin);
 assert.deepEqual(fs.readdirSync(paths.stateDir),['sidecar.lock'],'Inert broker created SDK keys or logs');
 const stopped=await request('/rpc/stop',{method:'POST',authorized:true});assert.equal(stopped.status,200);assert.equal(stopped.body.result.state,'stopped');
 await broker.close();broker=null;
 const descriptor=JSON.parse(fs.readFileSync(paths.ready,'utf8'));assert.equal(descriptor.phase,'stopped');
 assert.deepEqual(fs.readdirSync(paths.stateDir),['sidecar.lock']);
 for(const file of Object.keys(require.cache))assert(inside(file),'Loaded broker dependency outside ASAR after requests: '+file);
 console.log(JSON.stringify({ok:true,packagedBroker:true,inertBackend:true,realStart:false,realLogin:false,isolatedTemporaryProfile:true,authenticatedLoopbackControl:true,allProductionDependenciesInsideAsar:true,developmentFixtureDirectoriesExcluded:true,productionPackages:visited.size,loadedCommonJSModules:Object.keys(require.cache).length,optionalMissing:[...new Set(optionalMissing)].sort()}));
}finally{await broker?.close();}
