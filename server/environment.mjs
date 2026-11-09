import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {configureNative,physicalPath} from './fnos-native/configure.mjs';
import {nativeLifecycle} from './fnos-native/lifecycle.mjs';
import {runSupervisor} from './fnos-native/supervisor.mjs';

function options(argv){
 const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw Error('参数必须为 --name value');out[argv[i].slice(2)]=argv[i+1];}return out;
}
export async function main(argv=process.argv.slice(2)){
 const action=argv.shift(),o=options(argv);
 if(action==='configure'){
  const mode=o.mode||'fresh',fresh=mode==='fresh';
  if(!o.release||!o.data||fresh&&!o.origin)throw Error('configure fresh 需要 --release、--data 和真实 HTTPS --origin');
  const releaseRoot=physicalPath(o.release),dataRoot=physicalPath(o.data);
  const runtimeDir=o['runtime-dir']?physicalPath(o['runtime-dir']):fresh?path.join(path.dirname(dataRoot),path.basename(dataRoot)+'-runtime'):undefined;
  const browser=o.browser?JSON.parse(o.browser):fresh&&process.platform==='linux'?{enabled:true,runtimeRoot:path.join(path.dirname(releaseRoot),'runtime'),chromiumPath:path.join(path.dirname(releaseRoot),'runtime','chromium','chrome'),novncRoot:path.join(path.dirname(releaseRoot),'runtime','novnc')}:undefined;
  const file=await configureNative({releaseRoot,dataRoot,mode,sourceRoot:o.source,entry:o.entry||(fresh?'tailscale':undefined),publicOrigin:o.origin,runtimeDir,cmPath:o['cm-path'],requireBrowsers:o['require-browsers']!==undefined?o['require-browsers']==='true':fresh&&process.platform==='linux'?true:fresh?false:undefined,browser});
  return {ok:true,config:file};
 }
 if(!['start','serve','status','stop'].includes(action))throw Error('命令必须为 configure、start、serve、status 或 stop');
 if(!o.config)throw Error('需要 --config <absolute>');const file=physicalPath(o.config);
 if(action==='serve'){
  const running=await runSupervisor(file);console.log(JSON.stringify(running.status()));
  const interrupted=new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  await Promise.race([running.wait,interrupted]);await running.stop();return {ok:true,status:'stopped'};
 }
 return nativeLifecycle(action==='start'?'start':action,file);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(error.message);process.exitCode=1;});
