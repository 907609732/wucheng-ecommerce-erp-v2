import fs from 'node:fs';
import path from 'node:path';
import {warehouseAdapter,exporterAdapter} from '../desktop/workbench/descriptors.mjs';
const projects=path.resolve('apps');
const roots={purchase:path.join(projects,'purchase'),sales:path.join(projects,'sales'),overview:path.join(projects,'overview')};
const modules=[warehouseAdapter,exporterAdapter,...Object.entries(roots).map(([module,root])=>({module,...JSON.parse(fs.readFileSync(path.join(root,'workbench-manifest.json'),'utf8'))}))].map(source=>{
 const module=source.module||source.id;
 const operations=source.operations.map(o=>({...o,module,path:o.path.startsWith('/api/')||!source.basePath?o.path:source.basePath+o.path}));
 return {module,operations,hostOnly:source.hostOnly||[],counts:{total:operations.length,remote:operations.filter(x=>x.remote).length,hostOnly:operations.filter(x=>!x.remote).length}};
});
fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/workbench-interface-coverage.json',JSON.stringify({protocol:'workbench/v1',generatedAt:new Date().toISOString(),modules},null,2));
console.log(JSON.stringify(modules.map(({module,counts})=>({module,...counts}))));
