import fs from 'node:fs';
import path from 'node:path';
import {atomicJson,hostError} from './common.mjs';

export function createSafeSecretStore({storeDir,safeStorage}={}){
  const file=path.join(storeDir,'company-secrets.json');let writes=Promise.resolve();
  const nameOf=name=>{if(!/^[a-z][a-z0-9-]{1,79}$/.test(name))throw hostError('SECRET_NAME_INVALID','公司密钥名称无效');return name;};
  const read=()=>{try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.schemaVersion!==1||!data.values||Array.isArray(data.values))throw Error();return data.values;}catch(e){if(e.code==='ENOENT')return {};throw hostError('SECRET_STORE_INVALID','公司安全存储不可读取',503);}};
  async function available(){
    const ready=typeof safeStorage?.isAsyncEncryptionAvailable==='function'?await safeStorage.isAsyncEncryptionAvailable():safeStorage?.isEncryptionAvailable?.();
    if(!ready||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw hostError('SAFE_STORAGE_UNAVAILABLE','系统安全存储不可用，不能保存公司 API 密钥',503);
  }
  const serial=fn=>{const pending=writes.then(fn,fn);writes=pending.catch(()=>{});return pending;};
  const api={has:name=>typeof read()[nameOf(name)]==='string',async get(name){
    const encrypted=read()[nameOf(name)];if(!encrypted)return null;await available();
    const value=typeof safeStorage.decryptStringAsync==='function'?await safeStorage.decryptStringAsync(Buffer.from(encrypted,'base64')):safeStorage.decryptString(Buffer.from(encrypted,'base64'));
    const result=typeof value==='string'?value:value?.result;if(typeof result!=='string')throw hostError('SECRET_DECRYPT_FAILED','公司密钥无法解密',503);
    if(value?.shouldReEncrypt)await api.set(name,result);return result;
  },set(name,value){nameOf(name);if(typeof value!=='string'||!value||value.length>16384)throw hostError('SECRET_VALUE_INVALID','公司密钥内容无效');return serial(async()=>{
    await available();const encrypted=typeof safeStorage.encryptStringAsync==='function'?await safeStorage.encryptStringAsync(value):safeStorage.encryptString(value);
    if(!Buffer.isBuffer(encrypted))throw hostError('SECRET_ENCRYPT_FAILED','公司密钥无法加密',503);
    atomicJson(file,{schemaVersion:1,values:{...read(),[name]:encrypted.toString('base64')}});
  });},delete(name){nameOf(name);return serial(async()=>{const values=read();delete values[name];atomicJson(file,{schemaVersion:1,values});});}};
  return api;
}
