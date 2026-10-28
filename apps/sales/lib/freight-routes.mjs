import multer from 'multer';
import {freightReport,freightList,freightRecord,saveFreight,voidFreight,freightAttachment,exportFreight} from './freight.mjs';

export function installFreightRoutes(app,store) {
  const parse=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:5,fields:30,fieldSize:16*1024}}).array('files',5);
  const upload=(q,r,next)=>parse(q,r,error=>{
    if(error)return next(error);
    for(const file of q.files||[]){
      // Browser multipart filenames arrive through Busboy's Latin-1 default.
      const decoded=Buffer.from(file.originalname,'latin1').toString('utf8');
      if(!decoded.includes('\uFFFD')&&Buffer.from(decoded,'utf8').toString('latin1')===file.originalname)file.originalname=decoded;
    }
    next();
  });
  app.get('/api/freight/report',(q,r)=>r.json(freightReport(store,q.query)));
  app.get('/api/freight/records',(q,r)=>r.json(freightList(store,q.query)));
  app.get('/api/freight/records/:id',(q,r)=>r.json(freightRecord(store,q.params.id)));
  app.post('/api/freight/records',upload,(q,r)=>r.json(saveFreight(store,q.body,q.files)));
  app.put('/api/freight/records/:id',upload,(q,r)=>r.json(saveFreight(store,q.body,q.files,q.params.id)));
  app.post('/api/freight/records/:id/void',(q,r)=>r.json(voidFreight(store,q.params.id,q.body)));
  app.get('/api/freight/attachments/:id',(q,r)=>{
    const a=freightAttachment(store,q.params.id);
    // Only passive image/PDF formats may be viewed inline. Tables always download.
    if(q.query.download==='1'||!['image/png','image/jpeg','image/webp','application/pdf'].includes(a.mime))return r.download(a.absolute,a.filename);
    r.type(a.mime).sendFile(a.absolute);
  });
  app.get('/api/freight/export',async(q,r)=>{r.attachment('freight-'+String(q.query.period||'records')+'.xlsx');r.send(await exportFreight(store,q.query));});
}
