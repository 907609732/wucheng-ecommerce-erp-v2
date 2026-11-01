import {businessEnvelope} from './trust.mjs';
export async function registerBusinessRoutes(app,{requireSession,publicOrigin},runtime){
 const install=(route,review)=>app.post(route,{preHandler:requireSession,bodyLimit:80*1024*1024},async(request,reply)=>{
  const envelope=businessEnvelope(request.body),actor=request.workbenchActor;
  const trustedUi=actor.channel==='ui'&&request.headers.origin===publicOrigin;
  if(review&&!['list','get','approve','reject','receipt'].includes(envelope.operation))return reply.code(400).send({ok:false,error:'业务复核操作无效'});
  const operation=review?(envelope.operation==='receipt'?'receipt':'reviews.'+envelope.operation):envelope.operation;
  reply.header('cache-control','no-store');return runtime.request(operation,envelope.payload,{actor,trustedUi});
 });
 install('/api/workbench/v1/business/invoke',false);
 install('/api/workbench/v1/business/review',true);
}
