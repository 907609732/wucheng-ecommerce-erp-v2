import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';

export function provisionWorkbenchKey(dataDir){
  const file=path.join(dataDir,'.workbench-key');
  if(!fs.existsSync(file))fs.writeFileSync(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  return fs.readFileSync(file,'utf8').trim();
}
export function signWorkbenchActor(actor,key){
  const encoded=Buffer.from(JSON.stringify(actor)).toString('base64url');
  return {'x-workbench-actor':encoded,'x-workbench-actor-signature':createHmac('sha256',key).update(encoded).digest('hex')};
}
export function verifyWorkbenchActor(headers,key,{module,method,path:requestPath,now=Date.now()}){
  const fail=()=>{throw Object.assign(Error('工作台身份无效或已过期'),{status:403,code:'WORKBENCH_ACTOR_INVALID'});};
  const encoded=headers['x-workbench-actor'],signature=headers['x-workbench-actor-signature'];
  if(typeof encoded!=='string'||encoded.length>16384||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))return fail();
  const expected=createHmac('sha256',key).update(encoded).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return fail();
  let actor;try{actor=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{return fail();}
  if(actor.v!==1||actor.module!==module||actor.method!==method||actor.path!==requestPath||!Number.isFinite(actor.issuedAt)||!Number.isFinite(actor.expiresAt)||actor.issuedAt>now+5000||actor.issuedAt<now-60000||actor.expiresAt<=now||actor.expiresAt-actor.issuedAt>60000||typeof actor.login!=='string'||!actor.login||typeof actor.id!=='string'||!actor.id||!['admin','editor','viewer'].includes(actor.role)||!Array.isArray(actor.modules)||!actor.modules.includes(module)||typeof actor.canRunTasks!=='boolean'||!['ui','cli','mcp'].includes(actor.channel)||typeof actor.sessionId!=='string'||!actor.sessionId||typeof actor.requestId!=='string'||!actor.requestId)return fail();
  return actor;
}
