import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const factories=Object.freeze({purchase:'createPurchaseAgentAdapter',sales:'createSalesAgentAdapter',overview:'createOverviewAgentAdapter'});
// Roots come only from the guarded, activated service registry, never request input.
export async function loadActivatedBusinessAdapter(id,services,transport){
 const factory=factories[id];if(!factory)throw Error('Unsupported business adapter');
 const config=services.config(id);if(!config?.root||!path.isAbsolute(config.root))throw Error('Activated module root required');
 const root=fs.realpathSync(config.root),entry=fs.realpathSync(path.join(root,'lib','agent-adapter.mjs'));
 const relative=path.relative(root,entry);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Business adapter escapes activated module root');
 const module=await import(pathToFileURL(entry).href);
 if(typeof module[factory]!=='function')throw Error('Activated business adapter factory missing');
 return module[factory]({transport});
}
