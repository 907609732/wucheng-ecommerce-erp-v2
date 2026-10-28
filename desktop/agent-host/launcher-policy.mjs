import {hostError} from './common.mjs';
const allowed=new Set([
  'agent:request','launcher:ready','launcher:preferences','launcher:integration-config','launcher:copy-integration','launcher:update-check',
  'diagnostics:read','diagnostics:copy','diagnostics:export','diagnostics:open-folder','diagnostics:event','links:open',
  'connection:get','connection:status','connection:check','connection:network-plan','connection:save','connection:cached',
  'tailnet:status','tailnet:login','tailnet:connect','tailnet:logout','permissions:get','personnel:state','modules:list','desks:hide','desks:bounds'
]);
/** Beta components and ledger copies are immutable outside the validated packaging/migration tools. */
export function assertLauncherOperationAllowed(name){if(!allowed.has(name))throw hostError('BETA_MAINTENANCE_DISABLED','测试版组件和账本由独立验收工具维护，此旧操作已停用',403);}
export function assertLegacyAgentReadOnly(request){
  const read=['help','status','capabilities','extensions','debug-logs','debug-bundle'].includes(request?.command)||request?.command==='extension-call'&&['status','query'].includes(request.action);
  if(!read)throw hostError('LEGACY_AGENT_WRITE_DISABLED','此旧命令不能修改测试账本，请在统一任务结果页复核',403);
}
