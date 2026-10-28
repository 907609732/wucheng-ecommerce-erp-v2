import {installAgentService} from './agent-service.mjs';
import {createOverviewAgentActions} from './agent-actions.mjs';
import {overviewAgentCapabilities} from './agent-adapter.mjs';
import {hash,fail} from './util.mjs';
import {makeBackup} from './files.mjs';
export function installOverviewAgentRoutes({app,integration,store,sources,cainiao}){
 const actions=createOverviewAgentActions({store,sources,cainiao});
 return installAgentService({app,integration,store,module:'overview',capabilities:overviewAgentCapabilities,actions,
  binding:()=>({dataSetId:integration.state.dataSetId,revision:hash({business:integration.state.revision,sources:sources().sourceVersions})}),
  authorize:(actor,cap)=>{if(actor.role!=='admin'&&!['overview.template','overview.cainiao-status'].includes(cap.id))throw fail('经营总览财务任务须由老板权限人员操作',403);},backup:()=>makeBackup(store)});
}
