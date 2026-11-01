import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const dir=path.join(process.env.LOCALAPPDATA||process.cwd(),'PurchaseDesk','ocr-models');fs.mkdirSync(dir,{recursive:true});
for(const lang of ['chi_sim','eng']){
 const target=path.join(dir,lang+'.traineddata');if(fs.existsSync(target)){console.log(lang+' 模型已就绪');continue;}
 const url=`https://tessdata.projectnaptha.com/4.0.0_fast/${lang}.traineddata.gz`;
 console.log('下载 '+lang+' 本地识别模型…');let data;
 try{const res=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error('模型下载失败 '+res.status);data=gunzipSync(Buffer.from(await res.arrayBuffer()));}
 catch{const fallback=`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`;execFileSync('curl.exe',['--retry','3','--connect-timeout','15','-L','--fail',fallback,'-o',target+'.tmp'],{stdio:'inherit'});data=fs.readFileSync(target+'.tmp');}
 if(data.length<100000)throw Error('模型文件无效');fs.writeFileSync(target+'.tmp',data);fs.renameSync(target+'.tmp',target);console.log(lang+' 已安装 '+data.length+' bytes SHA256 '+createHash('sha256').update(data).digest('hex'));
}
console.log('本地 OCR 模型已准备完成，识别时无需联网。');
