import {validateOcrPageCount} from '../public/upload-limits.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createWorker,PSM} from 'tesseract.js';
import sharp from 'sharp';
import {createCanvas,DOMMatrix,ImageData,Path2D} from '@napi-rs/canvas';
import {extractText} from './importer.mjs';

const bundledModels=path.resolve(import.meta.dirname,'../resources/ocr');
export const modelDir=fs.existsSync(path.join(bundledModels,'chi_sim.traineddata'))?bundledModels:path.join(process.env.LOCALAPPDATA||process.cwd(),'PurchaseDesk','ocr-models');
export async function recognize(buffer,filename,onProgress=()=>{}){
 return recognizeBatch([{buffer,filename}],onProgress);
}
export async function recognizeBatch(files,onProgress=()=>{}){
 if(!['chi_sim','eng'].every(lang=>fs.existsSync(path.join(modelDir,`${lang}.traineddata`))))throw Error('本地识别模型尚未安装，请运行“安装识别模型.cmd”后重试');
 const pages=[];let pageCount=0;
 for(const [fileIndex,{buffer,filename}] of files.entries()){
 if(/\.pdf$/i.test(filename)){
  globalThis.DOMMatrix||=DOMMatrix;globalThis.ImageData||=ImageData;globalThis.Path2D||=Path2D;
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask=pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false});
  const pdf=await loadingTask.promise;
  try{
   pageCount+=pdf.numPages;validateOcrPageCount(pageCount);
   for(let i=1;i<=pdf.numPages;i++){
    const p=await pdf.getPage(i);const content=await p.getTextContent();
    const t=content.items.map(x=>(x.str||'')+(x.hasEOL?'\n':' ')).join('');
    if(t.replace(/\s/g,'').length>40){pages.push({fileIndex,text:t});continue;}
    const viewport=p.getViewport({scale:1.7});const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await p.render({canvasContext:canvas.getContext('2d'),viewport}).promise;pages.push({fileIndex,image:canvas.toBuffer('image/png')});
   }
  }finally{await loadingTask.destroy();}
 }else{
  validateOcrPageCount(++pageCount);
  const img=sharp(buffer,{limitInputPixels:30000000}).rotate().flatten({background:'#fff'});const info=await img.metadata();
  pages.push({fileIndex,image:await img.resize({width:Math.min(2400,Math.max(1400,info.width||1400)),withoutEnlargement:false}).normalize().png().toBuffer()});
 }
 }
 const images=pages.filter(p=>p.image);
 if(images.length){
  let page=0;const worker=await createWorker(['chi_sim','eng'],1,{langPath:modelDir,cachePath:modelDir,gzip:false,cacheMethod:'readOnly',logger:m=>{if(m.status==='recognizing text')onProgress(Math.round(((page+m.progress)/images.length)*95));}});
  try{await worker.setParameters({tessedit_pageseg_mode:PSM.AUTO,preserve_interword_spaces:'1'});for(const entry of images){const {data}=await worker.recognize(entry.image);entry.text=data.text;page++;}}finally{await worker.terminate();}
 }
 const documents=files.map(({filename},i)=>({filename,text:pages.filter(p=>p.fileIndex===i).map(p=>p.text||'').join('\n').trim()}));
 const text=documents.map(d=>d.text).join('\n\n').trim();if(!text)throw Error('没有识别到文字，请使用清晰、摆正的图片，或粘贴订单文字');
 const warnings=documents.filter(d=>!d.text).map(d=>`“${d.filename}”未识别到文字，请对照原图补齐。`);
 const orderNos=[...new Set(documents.map(d=>extractText(d.text).orderNo).filter(Boolean))];
 if(orderNos.length>1)throw Error('这些图片包含不同订单编号，请按一笔采购单分批识别');
 onProgress(100);return {text,order:extractText(text),documents,warnings};
}
