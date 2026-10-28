import {agentEnvelope} from './trust.mjs';

export async function registerAgentRoutes(app,{requireSession,publicOrigin},runtime){
  app.post('/api/workbench/v1/agent/request',{preHandler:requireSession,bodyLimit:48*1024*1024},async(request,reply)=>{
    const envelope=agentEnvelope(request.body),actor=request.workbenchActor;
    // resolveActor already checked membership, session channel, exact Origin and CSRF.
    const trustedUi=actor.channel==='ui'&&request.headers.origin===publicOrigin;
    reply.header('cache-control','no-store');
    return runtime.request(envelope.operation,envelope.payload,{actor,trustedUi});
  });
}
