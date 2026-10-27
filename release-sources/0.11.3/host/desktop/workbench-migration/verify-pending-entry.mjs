// Private same-package worker. Arguments are supplied only by the launcher;
// this is not a registered CLI, MCP tool, HTTP route or arbitrary file runner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ServiceManager} from '../shared/service-manager.mjs';
import {verifyPendingLocalDataMoves} from './local-data-move.mjs';
const protocol='lingtu-pending-verification/v1';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
try{
 const [registryFile,registrySha256,expectedVersion,...extra]=process.argv.slice(2);
 const version=JSON.parse(fs.readFileSync(new URL('../launcher/package.json',import.meta.url),'utf8')).version;
 if(extra.length||!path.isAbsolute(registryFile||'')||!/^([a-f0-9]{64})$/.test(registrySha256||'')||expectedVersion!==version)throw Object.assign(Error('内部核对参数或程序版本不符'),{code:'INVALID_VERIFICATION_REQUEST'});
 const validate=()=>{if(digest(fs.readFileSync(registryFile))!==registrySha256)throw Object.assign(Error('核对期间注册表绑定发生变化'),{code:'MOVE_OWNERSHIP_CHANGED'});};
 validate();const services=new ServiceManager({registryFile});verifyPendingLocalDataMoves(services,{beforeCommit:validate});validate();
 process.stdout.write(JSON.stringify({protocol,ok:true,version,registrySha256}));
}catch(error){process.stdout.write(JSON.stringify({protocol,ok:false,code:error.code||'VERIFICATION_FAILED',error:error.message,differences:error.differences}));process.exitCode=1;}
