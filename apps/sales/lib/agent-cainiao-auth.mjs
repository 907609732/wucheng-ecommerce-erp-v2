import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fail} from './util.mjs';

// Windows DPAPI binds the encrypted value to the current Windows user.
// The plaintext travels through anonymous pipes, never command arguments or logs.
async function dpapi(value,decrypt=false){
 if(process.platform!=='win32')throw fail('记住授权目前仅支持 Windows');
 const script="$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $e=[Text.Encoding]::UTF8.GetBytes('lingtu-cainiao-authorization-v1'); "+(decrypt?
  "$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($b));":
  "$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($b));");
 return new Promise((resolve,reject)=>{
  const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(exe,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','ignore']});let output='',settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(fail(error)):resolve(result);};
  const timer=setTimeout(()=>{child.kill();finish('本机授权加密处理超时');},15000);
  child.on('error',()=>finish('无法调用 Windows 本机加密服务'));child.stdin.on('error',()=>finish('本机授权加密处理失败'));
  child.stdout.on('data',b=>{output+=b.toString();if(output.length>32768){child.kill();finish('授权文件格式无效');}});
  child.on('close',code=>{if(code!==0)return finish(decrypt?'无法读取本机授权，请重新配置':'保存本机授权失败');const text=output.trim();if(!/^[A-Za-z0-9+/=]+$/.test(text))return finish('本机授权加密结果无效');finish(null,decrypt?Buffer.from(text,'base64').toString('utf8'):text);});
  child.stdin.end(value);
 });
}
export function normalizeAuthorization(value){
 if(typeof value!=='string')throw fail('请粘贴 Playwright 扩展中的授权令牌');
 const token=value.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/, '').replace(/^(["'])(.*)\1$/, '$2');
 if(!/^[A-Za-z0-9_+\/=.-]{16,1024}$/.test(token))throw fail('授权令牌格式无效，请只复制扩展显示的令牌值');
 return token;
}
export class CainiaoAuthorization{
 constructor(dir){this.file=path.join(dir,'.cainiao-authorization.dpapi');}
 has(){return fs.existsSync(this.file);}
 async save(value){const token=normalizeAuthorization(value),blob=await dpapi(token),tmp=this.file+'.'+randomUUID()+'.part';fs.mkdirSync(path.dirname(this.file),{recursive:true});try{fs.writeFileSync(tmp,JSON.stringify({version:1,blob}),{flag:'wx',mode:0o600});fs.renameSync(tmp,this.file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
 async load(){if(!this.has())return '';try{const data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(data.version!==1||typeof data.blob!=='string'||data.blob.length>32768)throw Error();return normalizeAuthorization(await dpapi(data.blob,true));}catch{throw fail('本机授权已失效或不可读取，请重新粘贴扩展令牌');}}
 forget(){if(this.has())fs.unlinkSync(this.file);}
}
