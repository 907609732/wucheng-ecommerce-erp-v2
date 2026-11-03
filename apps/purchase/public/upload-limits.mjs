export const MAX_FILES=20;
export const MAX_FILE_BYTES=50*1024*1024;
export const MAX_TOTAL_BYTES=200*1024*1024;
const mb=bytes=>(bytes/1024/1024).toFixed(2)+' MB';
export const uploadLimitError=message=>Object.assign(Error(message),{code:'UPLOAD_LIMIT',status:413});
export function validateUploadLimits(files){
 if(files.length>MAX_FILES)throw uploadLimitError(`当前共 ${files.length} 个附件，每单最多 ${MAX_FILES} 个，请减少后重试。`);
 let total=0;
 for(const f of files){
  const bytes=f.size??f.bytes??0;total+=bytes;
  if(bytes>MAX_FILE_BYTES)throw uploadLimitError(`“${f.name||f.filename||'附件'}”大小为 ${mb(bytes)}，单个文件最多 50 MB，请缩小后重试。`);
 }
 if(total>MAX_TOTAL_BYTES)throw uploadLimitError(`当前附件合计 ${mb(total)}，每单最多 200 MB，请减少后重试。`);
}
