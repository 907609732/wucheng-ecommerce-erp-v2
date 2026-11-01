import {ServiceManager} from './service-manager.mjs';
export function registerTransferRoutes(integration,transfers,store){
  const {router:r,requireReview:ui}=integration,manager=new ServiceManager();
  r.get('/orders',(q,s)=>{const term=String(q.query.q||'');s.json({orders:store.list().filter(o=>!term||[o.orderNo,o.supplier,o.account,...o.items.map(i=>i.title)].join(' ').includes(term)).slice(0,1000)});});
  r.get('/transfers',(_q,s)=>s.json({batches:transfers.list()}));
  r.post('/transfers',(q,s)=>s.json(transfers.create(q.body)));
  r.get('/transfers/:id',(q,s)=>s.json(transfers.preview(q.params.id)));
  r.put('/transfers/:id',(q,s)=>s.json(transfers.save(q.params.id,q.body)));
  r.post('/transfers/:id/review',ui,(q,s)=>s.json(transfers.review(q.params.id,q.body.revision,q.integration.session)));
  r.post('/transfers/:id/confirm',ui,(q,s)=>s.json(transfers.confirm(q.params.id,q.body.revision,q.integration.session)));
  r.post('/transfers/:id/commit',ui,async(q,s)=>s.json(await transfers.commit(q.params.id,q.body.receipt,q.integration.session,q.integration.actor)));
  r.get('/transfers/:id/verification',(q,s)=>s.json({differences:transfers.verify(q.params.id)}));
  r.post('/transfers/:id/rollback',ui,(q,s)=>s.json(transfers.rollback(q.params.id,q.body.reason)));
  r.post('/exporter/open',async(q,s)=>s.json(q.workbenchActor?{route:'/apps/exporter/'}:await manager.ensure('exporter')));
}
