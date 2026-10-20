import fs from 'node:fs';
import path from 'node:path';
export function installBundledDesks({source,workspace,settingsPath}){
  const target=path.join(workspace,'extensions','lingtu-desks');
  fs.mkdirSync(target,{recursive:true});
  for(const name of ['extension.json','extension.mjs','service-manager.mjs'])fs.copyFileSync(path.join(source,name),path.join(target,name));
  const settings=fs.existsSync(settingsPath)?JSON.parse(fs.readFileSync(settingsPath,'utf8')):{firstRunPending:true};
  if(!(settings.trustedExtensionIds||[]).includes('lingtu.desks')){
    settings.trustedExtensionIds=[...(settings.trustedExtensionIds||[]),'lingtu.desks'];
    fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2)+'\n');
  }
}
