import {recognizeBatch} from './ocr.mjs';
const controller=new AbortController();let started=false;
const send=value=>{if(process.connected)process.send(value);};
process.on('disconnect',()=>{controller.abort();process.exit(0);});
process.on('message',async({files,cancel})=>{
 if(cancel){controller.abort();return;}
 if(started||!Array.isArray(files))return;started=true;
 try{controller.signal.throwIfAborted();const result=await recognizeBatch(files.map(({data,filename})=>({buffer:Buffer.from(data,'base64'),filename})),progress=>send({progress}),{signal:controller.signal});controller.signal.throwIfAborted();send({result});}
 catch(e){send(controller.signal.aborted?{cancelled:true}:{error:e.message,code:e.code});}
 finally{if(process.connected)process.disconnect();}
});
