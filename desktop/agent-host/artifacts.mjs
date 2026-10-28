import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertPrivateFile,hostError} from './common.mjs';

export function artifactDownload(storeDir,item,{maxBytes=32*1024*1024}={}){
  if(!item||typeof item.taskId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(item.taskId))throw hostError('ARTIFACT_SCOPE_DENIED','任务产物标识无效',403);
  const {file,stat}=assertPrivateFile(path.join(storeDir,'tasks',item.taskId),item.path);
  if(stat.size>maxBytes)throw hostError('ARTIFACT_TOO_LARGE','此产物超过下载大小上限，请拆分生成',413);
  const bytes=fs.readFileSync(file),sha256=createHash('sha256').update(bytes).digest('hex');
  if(item.sha256&&item.sha256!==sha256)throw hostError('ARTIFACT_CHANGED','文件已变化，请重新生成后下载',409);
  const name=path.basename(item.name||file).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,180)||'result';
  return {download:{name,mimeType:item.mimeType||'application/octet-stream',size:bytes.length,sha256,bytes:bytes.toString('base64')}};
}
export async function saveArtifactDownload(result,{dialog,window,downloads}){
  const item=result?.download;if(!item)return result;
  if(typeof item.name!=='string'||item.name!==path.basename(item.name)||/[<>:"/\\|?*\x00-\x1f]/.test(item.name)||typeof item.bytes!=='string'||item.bytes.length>45*1024*1024)throw hostError('ARTIFACT_RESPONSE_INVALID','产物下载信息无效',502);
  const bytes=Buffer.from(item.bytes,'base64');
  if(bytes.length!==item.size||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw hostError('ARTIFACT_RESPONSE_INVALID','产物完整性校验失败',502);
  const choice=await dialog.showSaveDialog(window,{title:'保存任务结果',defaultPath:path.join(downloads,item.name)});
  if(choice.canceled)return {cancelled:true};
  await fs.promises.writeFile(choice.filePath,bytes,{flag:'wx',mode:0o600});
  return {saved:true,name:path.basename(choice.filePath),size:bytes.length};
}
