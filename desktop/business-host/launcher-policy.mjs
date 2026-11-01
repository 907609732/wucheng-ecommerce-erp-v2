import {hostError} from './common.mjs';
import {WORKBENCH_MODULES} from '../workbench/actor.mjs';
const allowed=new Set([
  'extension:status','extension:plan','extension:install','extension:cancel',
  'business:status','business:backup','business:review','launcher:ready','launcher:preferences','launcher:preferences-save','launcher:integration-config','launcher:copy-integration','launcher:update-check',
  'diagnostics:read','diagnostics:copy','diagnostics:export','diagnostics:open-folder','diagnostics:event','links:open',
  'connection:get','connection:status','connection:check','connection:network-plan','connection:save','connection:cached',
  'tailnet:status','tailnet:login','tailnet:connect','tailnet:logout','modules:list','desks:status','desks:hide','desks:bounds','desks:child-home','desks:data-changed'
]);
/** Beta components and ledger copies are immutable outside the validated packaging/migration tools. */
export function assertLauncherOperationAllowed(name,{moduleId}={}){
  if(name==='desks:surface'&&['purchase','sales','overview'].includes(moduleId))return;
  if(['modules:open','desks:open','desks:child-open'].includes(name)&&WORKBENCH_MODULES.includes(moduleId))return;
  if(!allowed.has(name))throw hostError('BETA_MAINTENANCE_DISABLED','测试版组件和账本由独立验收工具维护，此旧操作已停用',403);
}
