import fs from 'node:fs';
import path from 'node:path';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

export const WORKBENCH_ACTOR_HEADER = 'x-workbench-actor';
export const WORKBENCH_SIGNATURE_HEADER = 'x-workbench-actor-signature';
export const WORKBENCH_KEY_FILE = '.workbench-key';
export const WORKBENCH_MODULES = Object.freeze(['warehouse','purchase','sales','overview','exporter']);
const roles = new Set(['admin','editor','viewer']);
const channels = new Set(['ui','cli','mcp']);
const fail = message => Object.assign(new Error(message), {code:'INVALID_WORKBENCH_ACTOR',statusCode:401});

export function provisionWorkbenchKey(dataDir) {
  const file = path.join(dataDir, WORKBENCH_KEY_FILE);
  fs.mkdirSync(dataDir, {recursive:true});
  try { fs.writeFileSync(file, randomBytes(32).toString('hex'), {flag:'wx',mode:0o600}); }
  catch(error) { if(error.code !== 'EEXIST') throw error; }
  const key = fs.readFileSync(file, 'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(key)) throw fail('工作台代理密钥格式无效');
  return key;
}

export function signWorkbenchActor(actor, key) {
  if(!/^[a-f0-9]{64}$/i.test(String(key))) throw fail('工作台代理密钥格式无效');
  const encoded = Buffer.from(JSON.stringify(actor), 'utf8').toString('base64url');
  return {[WORKBENCH_ACTOR_HEADER]:encoded,
    [WORKBENCH_SIGNATURE_HEADER]:createHmac('sha256', key).update(encoded).digest('hex')};
}

export function verifyWorkbenchActor(headers, key, {module,method,path:requestPath,now=Date.now()}={}) {
  const encoded = headers?.[WORKBENCH_ACTOR_HEADER];
  const signature = headers?.[WORKBENCH_SIGNATURE_HEADER];
  if(typeof encoded !== 'string' || encoded.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature) ||
      !/^[a-f0-9]{64}$/i.test(String(key))) throw fail('工作台代理身份无效');
  const expected = createHmac('sha256',key).update(encoded).digest();
  if(!timingSafeEqual(Buffer.from(signature,'hex'),expected)) throw fail('工作台代理签名无效');
  let actor;
  try { actor = JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')); }
  catch { throw fail('工作台代理身份无效'); }
  if(actor?.v !== 1 || typeof actor.id !== 'string' || !actor.id || typeof actor.login !== 'string' || !actor.login ||
      !roles.has(actor.role) || !channels.has(actor.channel) || !Array.isArray(actor.modules) ||
      actor.modules.some(id=>!WORKBENCH_MODULES.includes(id)) || !WORKBENCH_MODULES.includes(actor.module) ||
      !actor.modules.includes(actor.module) || typeof actor.canRunTasks !== 'boolean' ||
      typeof actor.sessionId !== 'string' || !actor.sessionId || typeof actor.requestId !== 'string' || !actor.requestId ||
      !Number.isSafeInteger(actor.issuedAt) || !Number.isSafeInteger(actor.expiresAt) ||
      actor.issuedAt > now + 5000 || actor.expiresAt <= now || actor.expiresAt-actor.issuedAt > 60000 ||
      actor.module !== module || actor.method !== String(method).toUpperCase() || actor.path !== requestPath)
    throw fail('工作台代理身份已过期或不属于本次操作');
  return actor;
}
