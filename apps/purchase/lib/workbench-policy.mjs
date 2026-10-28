import {WORKBENCH_MODULES} from './workbench-actor.mjs';
const roles=new Set(['admin','editor','viewer']);
export function validatePolicy(policy){
  const invalid=()=>Object.assign(Error('工作台访问策略无效'),{statusCode:503,code:'ACCESS_POLICY_INVALID'});
  if(policy?.schemaVersion!==1||!policy.users||typeof policy.users!=='object'||Array.isArray(policy.users))throw invalid();
  for(const [login,p] of Object.entries(policy.users))if(login!==login.trim().toLowerCase()||!login||login.length>254||/[\s,\r\n]/.test(login)||!roles.has(p?.role)||!Array.isArray(p.modules)||p.modules.some(id=>!WORKBENCH_MODULES.includes(id))||typeof p.canRunTasks!=='boolean'||typeof p.enabled!=='boolean')throw invalid();
  return policy;
}

