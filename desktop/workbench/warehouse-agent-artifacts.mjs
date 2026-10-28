/** Host-side only. The signed download helper owns the task directory and invokes
 * ctx.registerArtifact; model input never supplies a path or download URL. */
export function createWarehouseArtifactMaterializer(transport){
  const registered=new Map();
  return async function materialize(output,ctx){
    if(!output?.evidence?.some(e=>e.artifactId))return output;
    // Direct module consumers have no central artifact registry. Runtime always
    // supplies registerArtifact; missing download support there must fail visibly.
    if(typeof ctx?.registerArtifact!=='function')return output;
    if(typeof transport.download!=='function')throw Object.assign(Error('主机尚未接入签名产物下载与中央登记'),{code:'WAREHOUSE_ARTIFACT_TRANSPORT_REQUIRED',statusCode:503});
    const evidence=[];
    for(const item of output.evidence){
      if(!item.artifactId){evidence.push(item);continue;}
      if(!/^[a-f0-9-]{36}$/i.test(item.artifactId)||!/^[a-f0-9]{64}$/i.test(item.sha256||''))throw Object.assign(Error('云仓原件标识或摘要无效'),{code:'WAREHOUSE_ARTIFACT_INVALID',statusCode:409});
      const key=[ctx.actor.id,ctx.taskId,item.artifactId,item.sha256].join(':');let artifact=registered.get(key);
      if(!artifact){
        const route='/api/integration/v1/workbench/agent-files/'+item.artifactId+'?payload='+encodeURIComponent(JSON.stringify({taskId:ctx.taskId}));
        const downloaded=await transport.download('warehouse',route,{ctx,expectedSha256:item.sha256,...(item.filename?{filename:item.filename}:{})});artifact=downloaded.artifact||downloaded;
        if(typeof artifact.id!=='string'||!artifact.id||artifact.sha256!==item.sha256)throw Object.assign(Error('中央产物登记未返回匹配的编号和摘要'),{code:'WAREHOUSE_ARTIFACT_REGISTER_FAILED',statusCode:409});
        artifact=Object.fromEntries(['id','name','mimeType','size','sha256','url','downloadUrl'].filter(k=>artifact[k]!==undefined).map(k=>[k,artifact[k]]));registered.set(key,artifact);
      }
      evidence.push({...item,label:artifact.name||'云仓原件',note:'SHA256 '+item.sha256,moduleArtifactId:item.artifactId,artifactId:artifact.id,artifact});
    }
    return {...output,evidence,blocks:[...(output.blocks||[]),{type:'files',title:'可下载的原件与备份',files:evidence.filter(e=>e.artifact).map(e=>e.artifact)}]};
  };
}
