import {agentError} from './approval.mjs';

export function createAgentSettings(store,{secretStore}={}){
  const defaults={id:'company',ownerId:'system',defaultEngine:'codex',company:{baseUrl:'https://api.openai.com/v1',model:'',budgetLimit:0,budgetUnit:'tokens'}};
  if(!store.get('settings','company'))store.insert('settings',defaults);
  let saving=Promise.resolve();
  function publicSettings(){const settings=store.get('settings','company');return {...settings,company:{...settings.company,hasKey:!!secretStore?.has?.('company-api-key')}};}
  return {get:publicSettings,
    async credentials(){const config=store.get('settings','company');const apiKey=await secretStore?.get?.('company-api-key');if(!apiKey)throw agentError('COMPANY_API_REQUIRED','请管理员在设置中配置公司 API；不会复用个人账号',409);if(!config.company.model)throw agentError('COMPANY_MODEL_REQUIRED','请管理员设置公司使用的模型名称',409);return {...config.company,apiKey};},
    save(input,actor){const operation=saving.then(async()=>{
      if(actor.role!=='admin')throw agentError('ADMIN_REQUIRED','只有管理员可以修改公司模型设置',403);
      const current=store.get('settings','company'),company={...current.company};
      if(input.version!==undefined&&input.version!==current.version)throw agentError('AGENT_REVISION_CHANGED','公司设置已变化，请重新加载后保存',409);
      if(input.defaultEngine&&!['codex','hermes'].includes(input.defaultEngine))throw agentError('ENGINE_INVALID','未知执行引擎');
      const incoming=input.company||{};
      if(incoming.baseUrl!==undefined){let url;try{url=new URL(incoming.baseUrl);}catch{throw agentError('API_URL_INVALID','模型 API 地址无效');}if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw agentError('API_URL_INVALID','模型 API 需要 HTTPS 或本机地址');company.baseUrl=url.href.replace(/\/$/,'');}
      if(incoming.model!==undefined)company.model=String(incoming.model).trim().slice(0,200);
      if(incoming.budgetLimit!==undefined){if(!Number.isSafeInteger(Number(incoming.budgetLimit))||Number(incoming.budgetLimit)<0)throw agentError('BUDGET_INVALID','额度必须是非负整数 token 数');company.budgetLimit=Number(incoming.budgetLimit);}
      const changingKey=!!incoming.apiKey||incoming.clearApiKey===true;
      const previousKey=changingKey?await secretStore?.get?.('company-api-key'):undefined;
      if(incoming.apiKey){if(typeof secretStore?.set!=='function')throw agentError('SECURE_STORAGE_UNAVAILABLE','系统安全凭据存储不可用，未保存密钥',503);await secretStore.set('company-api-key',String(incoming.apiKey));}
      if(incoming.clearApiKey===true)await secretStore?.delete?.('company-api-key');
      try{store.update('settings','company',{defaultEngine:input.defaultEngine||current.defaultEngine,company},{expectedVersion:current.version});}
      catch(error){if(changingKey){if(previousKey)await secretStore.set('company-api-key',previousKey);else await secretStore?.delete?.('company-api-key');}throw error;}
      return publicSettings();
    });saving=operation.catch(()=>{});return operation;}
  };
}
