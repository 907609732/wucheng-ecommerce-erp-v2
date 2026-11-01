import fs from 'node:fs';
import {PRODUCT_MODULES} from '../../desktop/product/modules.mjs';

export const TEST_UNITS=['host',...PRODUCT_MODULES.map(m=>m.id)];
export function testUnit(file){
  const name=file.toLowerCase();
  for(const module of PRODUCT_MODULES)if(module.tests.some(token=>name.includes(token)))return module.id;
  return 'host';
}
export function unitTests(root,id){
  return fs.readdirSync(root+'/tests').filter(name=>/\.test\.[cm]?js$/.test(name)&&testUnit(name)===id).sort().map(name=>'tests/'+name);
}
export function affectedUnits(paths){
  if(!paths.length)return [...TEST_UNITS];
  const selected=new Set();
  for(const file of paths){
    if(/^(?:docs\/|README\.md$)/.test(file))continue;
    const module=PRODUCT_MODULES.find(m=>m.source.startsWith('apps/')&&file.startsWith(m.source+'/'));
    if(module){selected.add(module.id);continue;}
    if(file.startsWith('tests/')&&/\.test\.[cm]?js$/.test(file)){selected.add(testUnit(file));continue;}
    return [...TEST_UNITS]; // Shared, unknown or configuration changes fan out.
  }
  return [...selected];
}
