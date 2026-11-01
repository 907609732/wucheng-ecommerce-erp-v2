import {MAX_FILES,MAX_FILE_BYTES,MAX_TOTAL_BYTES,validateUploadLimits} from './upload-limits.mjs';
export const OCR_MAX_FILES=MAX_FILES;
export const OCR_MAX_FILE_BYTES=MAX_FILE_BYTES;
export const OCR_MAX_TOTAL_BYTES=MAX_TOTAL_BYTES;
export function validateOcrFiles(files){
 if(!files.length)throw Error('请先添加采购单图片或 PDF');
 validateUploadLimits(files);
 for(const file of files){
  if(!/\.(png|jpe?g|webp|pdf)$/i.test(file.name))throw Error('支持 PNG、JPG、WebP 和 PDF');
  if(!file.size)throw Error('不能识别空文件');
 }
}
export function clipboardImages(transfer){
 const files=Array.from(transfer?.files||[]).filter(f=>f.type.startsWith('image/')||(!f.type&&/\.(png|jpe?g|webp)$/i.test(f.name||'')));
 return files.length?files:Array.from(transfer?.items||[]).filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
}
