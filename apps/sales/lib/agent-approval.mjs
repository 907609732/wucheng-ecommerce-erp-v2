import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

export const agentError=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode,workbenchPublic:true});
export function canonicalJson(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>canonicalJson(v??null)).join(',')+']';
  return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
}
export const agentDigest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const required=['approvalId','actorId','module','capabilityId','taskId','resultId','dataSetId','changeDigest','idempotencyKey'];
const bound=['actorId','module','capabilityId','taskId','resultId','resultVersion','dataSetId','revision','changeDigest','idempotencyKey'];
function validRevision(value){if(value===null||value===undefined)return false;if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0;if(typeof value==='string')return !!value&&value.length<=300;if(typeof value==='object'&&!Array.isArray(value))return Object.keys(value).length>0&&Object.keys(value).length<=100&&Object.values(value).every(validRevision);return false;}
function validate(claims,now){
  if(claims?.v!==1||required.some(k=>typeof claims[k]!=='string'||!claims[k]||claims[k].length>300)||!/^[a-f0-9]{64}$/.test(claims.changeDigest)||!Number.isSafeInteger(claims.resultVersion)||claims.resultVersion<1||!validRevision(claims.revision)||!Number.isSafeInteger(claims.issuedAt)||!Number.isSafeInteger(claims.expiresAt)||claims.issuedAt>now+5000||claims.expiresAt<=now||claims.expiresAt-claims.issuedAt>60000)throw agentError('AGENT_APPROVAL_INVALID','本次结果确认无效或已过期',403);
}
function checkKey(key){if(typeof key!=='string'||!/^[a-f0-9]{64}$/i.test(key))throw agentError('AGENT_APPROVAL_KEY_INVALID','模块复核签名密钥无效',503);}
export function signAgentApproval(claims,key,{now=Date.now()}={}){
  checkKey(key);validate(claims,now);
  const payload=Buffer.from(canonicalJson(claims)).toString('base64url');
  return {payload,signature:createHmac('sha256',key).update('erp-agent-review-v1:'+payload).digest('hex')};
}
export function verifyAgentApproval(proof,key,expected={}, {now=Date.now()}={}){
  checkKey(key);
  if(bound.some(key=>expected[key]===undefined))throw agentError('AGENT_APPROVAL_EXPECTATION_REQUIRED','业务接口必须绑定完整结果、人员、账本和幂等范围',500);
  if(typeof proof?.payload!=='string'||proof.payload.length>16384||!/^[A-Za-z0-9_-]+$/.test(proof.payload)||typeof proof.signature!=='string'||!/^[a-f0-9]{64}$/i.test(proof.signature))throw agentError('AGENT_APPROVAL_INVALID','缺少有效的人审凭据',403);
  const actual=createHmac('sha256',key).update('erp-agent-review-v1:'+proof.payload).digest();
  if(!timingSafeEqual(actual,Buffer.from(proof.signature,'hex')))throw agentError('AGENT_APPROVAL_INVALID','人审凭据签名无效',403);
  let claims;try{claims=JSON.parse(Buffer.from(proof.payload,'base64url').toString('utf8'));}catch{throw agentError('AGENT_APPROVAL_INVALID','人审凭据格式无效',403);}
  validate(claims,now);
  for(const [key,value]of Object.entries(expected))if(canonicalJson(claims[key])!==canonicalJson(value))throw agentError('AGENT_APPROVAL_MISMATCH','结果、账本或确认人员已变化，请重新复核',409);
  return claims;
}
export function approvalHeaders(proof){return {'x-erp-agent-approval':Buffer.from(JSON.stringify(proof)).toString('base64url')};}
export function approvalFromHeaders(headers){try{return JSON.parse(Buffer.from(String(headers?.['x-erp-agent-approval']||''),'base64url').toString('utf8'));}catch{throw agentError('AGENT_APPROVAL_INVALID','人审凭据格式无效',403);}}
