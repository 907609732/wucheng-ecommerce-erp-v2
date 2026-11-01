import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from '../agent-beta-stage.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),id=process.argv[2],stage=process.env.ERP_BUILD_STAGE;
if(!['host','purchase','sales','overview','exporter'].includes(id)||!stage||!path.isAbsolute(stage))throw Error('Known dependency unit and materialized stage required');
const unit=path.join(root,'tooling/build-units',id),output=path.join(unit,'dependencies');
if(path.dirname(output)!==unit||fs.existsSync(output)&&fs.lstatSync(output).isSymbolicLink())throw Error('Unsafe dependency output');
fs.rmSync(output,{recursive:true,force:true});fs.mkdirSync(output);
const source=id==='host'?stage:path.join(stage,'apps',id);
for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,name),path.join(output,name));
if(id==='host'){
 const pkg=JSON.parse(fs.readFileSync(path.join(output,'package.json'))),lock=JSON.parse(fs.readFileSync(path.join(output,'package-lock.json')));
 delete pkg.workspaces;delete lock.packages[''].workspaces;
 for(const [key,value]of Object.entries(lock.packages))if(key.startsWith('tooling/build-units/')||value.link===true)delete lock.packages[key];
 fs.writeFileSync(path.join(output,'package.json'),JSON.stringify(pkg));fs.writeFileSync(path.join(output,'package-lock.json'),JSON.stringify(lock));
}
run(output,['ci',...(id==='exporter'?[]:['--omit=dev']),'--ignore-scripts','--no-audit','--no-fund','--workspaces=false']);
