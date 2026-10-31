import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {agentBetaPaths,assertAgentRegistry} from '../agent-host/isolation.mjs';

const nativeComponents={warehouse:{name:'wucheng-agent-beta-warehouse',main:'desktop/main.mjs'},exporter:{name:'lingtu-order-export',main:'out/main/index.js'}};
const physicalFs=process.versions.electron?process.getBuiltinModule('original-fs'):fs;
export function selectedAgentComponent(argv){
 const flags=argv.filter(value=>value.startsWith('--agent-component'));
 if(!flags.length)return null;
 if(flags.length!==1||!/^--agent-component=(warehouse|exporter)$/.test(flags[0]))throw Error('组件启动参数不明确或不受支持');
 return flags[0].slice('--agent-component='.length);
}
function regular(file){
 let cursor=path.parse(file).root;
 for(const segment of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,segment);if(physicalFs.lstatSync(cursor).isSymbolicLink())throw Error('组件资源路径包含链接');}
 if(path.relative(file,physicalFs.realpathSync.native(file))!==''||!physicalFs.statSync(file).isFile())throw Error('组件资源路径被重定向或不是文件');
}
export function registeredAgentComponent({id,paths,executable,electronVersion=process.versions.electron,readPackage=file=>JSON.parse(fs.readFileSync(path.join(file,'package.json'),'utf8'))}){
 if(!nativeComponents[id]||!path.isAbsolute(executable))throw Error('组件入口未绑定');
 const trusted={...paths,sharedElectronExecutable:executable,sharedElectronVersion:electronVersion},registry=assertAgentRegistry(trusted),component=registry[id];
 if(component.sharedElectron!==true||path.relative(executable,component.exe)!=='')throw Error('组件没有绑定当前共享运行环境');
 const appRoot=path.join(component.root,'resources','app.asar');regular(appRoot);
 const pkg=readPackage(appRoot),expected=nativeComponents[id];
 if(pkg.name!==expected.name||pkg.main!==expected.main||pkg.version!==component.version)throw Error('组件包身份、入口或版本不符');
 return {id,appRoot,resourcesDir:path.dirname(appRoot),version:pkg.version,entry:path.join(appRoot,...pkg.main.split('/')),dataDir:component.dataDir,registryFile:paths.registryFile};
}

/** The only selector is a fixed module ID. Program/data paths come from the
 * isolated registry, never from a caller supplied app path or --app switch. */
export async function dispatchPackagedApplication({argv=process.argv,env=process.env,executable=process.execPath,load=specifier=>import(specifier)}={}){
 const id=selectedAgentComponent(argv);
 if(!id){
  for(const key of ['LINGTU_COMPONENT_ID','LINGTU_COMPONENT_APP_ROOT','LINGTU_COMPONENT_RESOURCES_DIR','LINGTU_COMPONENT_VERSION'])delete env[key];
  return load('./main.mjs');
 }
 if(!env.LOCALAPPDATA)throw Error('组件缺少独立本机配置根');
 const fixedRoot=path.join(env.LOCALAPPDATA,env.LINGTU_AGENT_PREVIEW==='1'?'WuchengAgentBeta-preview':'WuchengAgentBeta');
 const paths=agentBetaPaths({localAppData:env.LOCALAPPDATA,root:fixedRoot,preview:env.LINGTU_AGENT_PREVIEW==='1'});
 if(env.LINGTU_REGISTRY_PATH&&path.relative(paths.registryFile,path.resolve(env.LINGTU_REGISTRY_PATH))!=='')throw Error('组件注册表越出当前测试版');
 const component=registeredAgentComponent({id,paths,executable});
 const profileFlags=argv.filter(value=>value==='--user-data-dir'||value.startsWith('--user-data-dir='));
 if(profileFlags.some(value=>!value.startsWith('--user-data-dir=')||path.relative(component.dataDir,path.resolve(value.slice('--user-data-dir='.length)))!==''))throw Error('组件数据目录必须匹配固定注册表');
 if(id==='warehouse'&&!profileFlags.length)argv.push('--user-data-dir='+component.dataDir);
 env.LINGTU_REGISTRY_PATH=component.registryFile;
 env.LINGTU_COMPONENT_ID=id;env.LINGTU_COMPONENT_APP_ROOT=component.appRoot;env.LINGTU_COMPONENT_RESOURCES_DIR=component.resourcesDir;env.LINGTU_COMPONENT_VERSION=component.version;
 if(id==='exporter')env.LINGTU_EXPORTER_DATA_DIR=component.dataDir;
 return load(pathToFileURL(component.entry).href);
}
