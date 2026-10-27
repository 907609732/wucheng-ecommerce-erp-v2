import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Encryption is supplied by Electron safeStorage (Windows DPAPI). Never use a plaintext fallback.
export class SnapshotCache{
  constructor({root,encrypt,decrypt,maxBytes=12*1024*1024}){Object.assign(this,{root,encrypt,decrypt,maxBytes});}
  key(scope,module){
    if(!scope?.userId||!scope.serverId||!scope.dataSetId||!['warehouse','purchase','sales','overview','exporter'].includes(module))throw Error('离线缓存身份不完整');
    return crypto.createHash('sha256').update(JSON.stringify([scope.userId,scope.serverId,scope.dataSetId,module,scope.moduleDataSetId||null])).digest('hex');
  }
  async put(scope,module,data){
    const plain=JSON.stringify({scope,module,updatedAt:new Date().toISOString(),data});
    if(Buffer.byteLength(plain)>this.maxBytes)throw Error('离线快照超出缓存上限');
    const encrypted=await this.encrypt(plain);if(!Buffer.isBuffer(encrypted)&&!(encrypted instanceof Uint8Array))throw Error('安全存储未返回加密数据');
    fs.mkdirSync(this.root,{recursive:true});const file=path.join(this.root,this.key(scope,module)+'.dpapi'),tmp=file+'.tmp';fs.writeFileSync(tmp,encrypted,{mode:0o600});fs.renameSync(tmp,file);
  }
  async get(scope,module){
    const file=path.join(this.root,this.key(scope,module)+'.dpapi');if(!fs.existsSync(file))return null;
    const raw=fs.readFileSync(file);if(raw.length>this.maxBytes+1024*1024)throw Error('离线快照无效');
    const decrypted=await this.decrypt(raw),plain=typeof decrypted==='string'?decrypted:decrypted?.result;
    const row=JSON.parse(plain);
    if(this.key(row.scope,row.module)!==this.key(scope,module))throw Error('离线快照身份不符');
    return row;
  }
}
