import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const factories=Object.freeze({warehouse:'createWarehouseAgentAdapter',purchase:'createPurchaseAgentAdapter',sales:'createSalesAgentAdapter',overview:'createOverviewAgentAdapter',exporter:'createExporterAgentAdapter'});
// Roots come only from the guarded, activated service registry, never request input.
export async function loadActivatedBusinessAdapter(id,services,transport){
 const factory=factories[id];if(!factory)throw Error('Unsupported business adapter');
 await services.prepareComponent?.(id);
 const config=services.config(id);if(!config?.root||!path.isAbsolute(config.root))throw Error('Activated module root required');
 const root=fs.realpathSync(id==='warehouse'?path.join(config.root,'resources/app.asar.unpacked'):id==='exporter'?path.dirname(config.root):config.root),entry=fs.realpathSync(path.join(root,id==='warehouse'?'desktop/workbench/warehouse-agent.mjs':id==='exporter'?'src/main/agent-adapter.mjs':'lib/agent-adapter.mjs'));
 const relative=path.relative(root,entry);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Business adapter escapes activated module root');
 const module=await import(pathToFileURL(entry).href);
 if(typeof module[factory]!=='function')throw Error('Activated business adapter factory missing');
 return module[factory]({transport});
}
