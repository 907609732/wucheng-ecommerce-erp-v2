import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {warehouseAdapter,exporterAdapter} from '../desktop/workbench/descriptors.mjs';
const projects=path.join(os.homedir(),'Documents','ChatGPT');
const roots={purchase:path.join(projects,'采购'),sales:path.join(projects,'销售台'),overview:path.join(projects,'采购','采购台和销售额台聚合')};
const modules=[warehouseAdapter,exporterAdapter,...Object.entries(roots).map(([module,root])=>({module,...JSON.parse(fs.readFileSync(path.join(root,'workbench-manifest.json'),'utf8'))}))].map(source=>{
 const module=source.module||source.id;
 const operations=source.operations.map(o=>({...o,module,path:o.path.startsWith('/api/')||!source.basePath?o.path:source.basePath+o.path}));
 return {module,operations,hostOnly:source.hostOnly||[],counts:{total:operations.length,remote:operations.filter(x=>x.remote).length,hostOnly:operations.filter(x=>!x.remote).length}};
});
fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/workbench-interface-coverage.json',JSON.stringify({protocol:'workbench/v1',generatedAt:new Date().toISOString(),modules},null,2));
console.log(JSON.stringify(modules.map(({module,counts})=>({module,...counts}))));
