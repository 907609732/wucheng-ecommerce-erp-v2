import {AsyncLocalStorage} from 'node:async_hooks';
// Request-local provenance. No password, token, proof or model-supplied identity
// is stored. AsyncLocalStorage prevents overlapping requests sharing an actor.
export function createPurchaseActorContext(){
 const context=new AsyncLocalStorage();
 const clean=actor=>actor?.id?Object.freeze({id:actor.id,login:actor.login||actor.id,label:actor.label||actor.login||actor.id,sessionId:actor.sessionId||'',requestId:actor.requestId||'',channel:actor.channel||'',entry:actor.entry||(actor.channel==='ui'?'manual-ui':'agent')}):null;
 return {run:(actor,fn)=>context.run(clean(actor),fn),read:()=>context.getStore()||null,json:()=>JSON.stringify(context.getStore()||null)};
}
