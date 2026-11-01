/** Product inventory. Runtime, build and verification consume these stable IDs. */
export const PRODUCT_MODULES = Object.freeze([
  {id:'warehouse', name:'云仓同步', source:'core', entry:'desktop/main.mjs', surface:'window', database:'workspace/data/erp.sqlite', dependencies:['node-runtime','browser-runtime'], tests:['inventory','warehouse','cainiao']},
  {id:'purchase', name:'采购台', source:'apps/purchase', entry:'server.mjs', surface:'embedded', database:'purchases.sqlite', dependencies:['node-runtime'], tests:['purchase']},
  {id:'sales', name:'销售台', source:'apps/sales', entry:'server.mjs', surface:'embedded', database:'sales.sqlite', dependencies:['node-runtime'], tests:['sales']},
  {id:'overview', name:'经营收支总览', source:'apps/overview', entry:'server.mjs', surface:'embedded', database:'overview.sqlite', dependencies:['node-runtime'], tests:['overview']},
  {id:'exporter', name:'订单导出', source:'apps/exporter', entry:'runtime/resources/app.asar', surface:'window', database:'orders.sqlite', dependencies:['node-runtime'], tests:['exporter']},
].map(value=>Object.freeze({...value, dependencies:Object.freeze(value.dependencies), tests:Object.freeze(value.tests)})));
export const PRODUCT_MODULE_IDS = Object.freeze(PRODUCT_MODULES.map(value=>value.id));
export const OPTIONAL_MODULE_IDS = Object.freeze(['warehouse']);
export const DEFAULT_MODULE_IDS = Object.freeze(PRODUCT_MODULE_IDS.filter(id=>!OPTIONAL_MODULE_IDS.includes(id)));
export const RUNTIME_IDS = Object.freeze(['node-runtime','browser-runtime']);
export const COMPONENT_IDS = Object.freeze([...PRODUCT_MODULE_IDS,...RUNTIME_IDS]);
export function productModule(id){return PRODUCT_MODULES.find(value=>value.id===id);}
