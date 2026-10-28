// Cloudflare Worker：接收灵兔采购台日活/使用次数上报，存 KV。
// 部署：wrangler 绑定一个 KV 命名空间，名称为 USAGE；把 Worker 地址填入灵兔采购台 config.json 的 statsEndpoint。
export default {
 async fetch(req, env){
  const url=new URL(req.url);
  if(req.method==='POST'&&url.pathname==='/api/open'){
   const b=await req.json();
   if(!b.installId||!b.day)return json({error:'缺少 installId 或 day'},400);
   // 同一安装当天多次打开：DAU 只算一次，总次数逐次累加。
   await env.USAGE.put(`dau:${b.day}:${b.installId}`,'1');
   const total=await env.USAGE.get('total-opens')||'0';
   await env.USAGE.put('total-opens',String(Number(total)+1));
   return json({ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/api/stats'){
   const day=url.searchParams.get('day')||new Date().toISOString().slice(0,10);
   const list=await env.USAGE.list({prefix:`dau:${day}:`});
   const total=await env.USAGE.get('total-opens')||'0';
   return json({day,dau:list.keys.length,totalOpens:Number(total)});
  }
  return json({error:'not found'},404);
 }
};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','access-control-allow-origin':'*'}});}
