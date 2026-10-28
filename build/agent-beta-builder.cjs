const {spawnSync}=require('node:child_process');
const path=require('node:path');
const result=spawnSync(process.execPath,[path.join(__dirname,'../scripts/agent-beta-coverage.mjs'),'check'],{encoding:'utf8'});
if(result.status!==0)throw Error('Beta coverage incomplete; installer creation blocked: '+result.stderr);
// Host integration must explicitly implement and validate isolated profile, services and update settings.
throw Error('Beta host isolation is not integrated or verified; installer creation blocked');
