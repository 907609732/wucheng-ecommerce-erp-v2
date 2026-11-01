import {recognizeBatch} from './ocr.mjs';
process.on('message',async({files})=>{
 try{const result=await recognizeBatch(files.map(({data,filename})=>({buffer:Buffer.from(data,'base64'),filename})),progress=>process.send({progress}));process.send({result});}
 catch(e){process.send({error:e.message,code:e.code});}
 finally{process.disconnect();}
});
