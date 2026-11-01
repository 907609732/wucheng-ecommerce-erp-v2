import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cloneFiles,pruneDeploymentMaps} from './files.mjs';
import {copyTree,copyComponentResources,run,prunePublicDependencyFixtures,buildWarehouse,commonElectron} from '../agent-beta-stage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const id=process.argv[2],stage=process.env.ERP_BUILD_STAGE;
if(!['host','warehouse','purchase','sales','overview','exporter'].includes(id)||!stage||!path.isAbsolute(stage))throw Error('A materialized source stage and known build unit are required');
const unit=path.join(root,'tooling/build-units',id),phase=process.argv[3]||'build',artifact=path.join(unit,phase==='deps'?'dependencies':'artifact');
// Only this unit's generated output is replaced; source and other units stay intact.
const resolved=path.resolve(artifact);
if(path.dirname(resolved)!==unit||fs.existsSync(resolved)&&fs.lstatSync(resolved).isSymbolicLink())throw Error('Unsafe build output');
fs.rmSync(resolved,{recursive:true,force:true});fs.mkdirSync(resolved);
const started=Date.now();
if(id==='host'){
  cloneFiles(path.join(unit,'dependencies/node_modules'),path.join(artifact,'node_modules'));
  pruneDeploymentMaps(path.join(artifact,'node_modules'));
}else if(id==='warehouse'){
  const work=path.join(artifact,'project');fs.mkdirSync(work);
  for(const name of ['desktop','core'])copyTree(path.join(stage,name),path.join(work,name));
  fs.copyFileSync(path.join(stage,'package.json'),path.join(work,'package.json'));
  cloneFiles(path.join(root,'tooling/build-units/host/artifact/node_modules'),path.join(work,'node_modules'));
  buildWarehouse(work);
  fs.renameSync(path.join(work,'apps/warehouse'),path.join(artifact,'app'));
  // Keep dependency caching in the host task, not twice in warehouse outputs.
  fs.rmSync(work,{recursive:true,force:true});
}else{
  const project=path.join(artifact,'project'),app=id==='exporter'?path.join(project,'apps/exporter'):path.join(artifact,'app');copyTree(path.join(stage,'apps',id),app);
  cloneFiles(path.join(unit,'dependencies/node_modules'),path.join(app,'node_modules'));
  if(id!=='exporter')pruneDeploymentMaps(path.join(app,'node_modules'));
  else{
    fs.mkdirSync(path.join(project,'desktop/shared'),{recursive:true});
    for(const name of ['component-context.mjs','component-context.d.mts'])fs.copyFileSync(path.join(stage,'desktop/shared',name),path.join(project,'desktop/shared',name));
    for(const [entry,args]of [['vue-tsc/bin/vue-tsc.js',['--noEmit']],['electron-vite/bin/electron-vite.js',['build']]]){
      const step=spawnSync(process.execPath,[path.join(app,'node_modules',entry),...args],{cwd:app,stdio:'inherit',windowsHide:true});if(step.status!==0)throw Error('Exporter compile failed: '+entry);
    }
    const electron=commonElectron(),output=path.join(artifact,'native'),config=path.join(artifact,'builder.cjs');
    fs.writeFileSync(config,'module.exports='+JSON.stringify({appId:'com.wucheng.ecommerce.erp.v2.agentbeta.exporter',productName:'五成订单导出台 Beta',executableName:'WuchengAgentBetaExporter',electronVersion:electron.version,electronDist:electron.dist,directories:{output},files:['out/**','build/icon.png','package.json','!**/*.map'],asar:true,npmRebuild:false,win:{icon:path.join(app,'build/icon.ico'),target:[{target:'dir',arch:['x64']}]}}));
    const result=spawnSync(process.execPath,[path.join(app,'node_modules/electron-builder/cli.js'),'--projectDir',app,'--config',config,'--win','--dir','--publish','never'],{cwd:app,stdio:'inherit',windowsHide:true});
    if(result.status!==0)throw Error('Exporter component build failed');
    copyComponentResources(path.join(output,'win-unpacked'),path.join(app,'runtime'));
    const prune=spawnSync(process.execPath,[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'prune','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--workspaces=false'],{cwd:app,stdio:'inherit',windowsHide:true});if(prune.status!==0)throw Error('Exporter production dependency pruning failed');
    pruneDeploymentMaps(path.join(app,'node_modules'));
    fs.renameSync(app,path.join(artifact,'app'));prunePublicDependencyFixtures(path.join(artifact,'app'));fs.rmSync(project,{recursive:true,force:true});
    fs.rmSync(output,{recursive:true,force:true});fs.unlinkSync(config);
  }
}
fs.writeFileSync(path.join(artifact,'build-receipt.json'),JSON.stringify({id,elapsedMs:Date.now()-started,node:process.version,platform:process.platform,arch:process.arch},null,2));
