const fail=(message)=>Object.assign(Error(message),{code:'INVALID_CLI_REQUEST'});
const params=value=>{
  const object=value===undefined?{}:value;
  if(!object||typeof object!=='object'||Array.isArray(object)||Buffer.byteLength(JSON.stringify(object),'utf8')>65536)throw fail('CLI 参数必须是最多 64 KiB 的 JSON 对象');
  return object;
};

// Serialize only fixed CLI verbs and flags; no shell is involved.
export function legacyCliArgs(request){
  const command=request?.command;
  if(['help','status','capabilities','doctor','debug-bundle','extensions'].includes(command))return [command];
  if(command==='logs')return ['logs','--limit='+Math.max(1,Math.min(100,Number(request.limit)||30))];
  if(command==='debug-logs')return ['debug-logs','--limit='+Math.max(1,Math.min(100,Number(request.limit)||50)),'--level='+(['any','error','warning','info'].includes(request.level)?request.level:'any'),'--query='+String(request.query||'').slice(0,100)];
  if(command==='extension-call')return [command,'--id='+request.id,'--action='+request.action,'--params-base64='+Buffer.from(JSON.stringify(params(request.params)),'utf8').toString('base64url'),...(request.confirmSideEffect===true?['--confirm-side-effect']:[])];
  if(command==='extension-trust'&&request.confirmed===true)return [command,'--id='+request.id,'--confirm-trust-code'];
  if(['sync','send-latest-valid'].includes(command)&&request.confirmed===true)return [command,'--confirm-send'];
  if(command==='login'&&request.confirmed===true)return [command,'--confirm-open-browser'];
  throw fail('命令缺少本次确认或不支持的 CLI 操作');
}
