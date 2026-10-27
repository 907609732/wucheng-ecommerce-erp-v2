// 升级检查：后台请求 GitHub Releases 最新版本，与当前版本对比。失败静默返回，不打断使用。
const cmp=(a,b)=>{
 const pa=String(a).replace(/^v/,'').split('.').map(n=>parseInt(n,10)||0);
 const pb=String(b).replace(/^v/,'').split('.').map(n=>parseInt(n,10)||0);
 for(let i=0;i<Math.max(pa.length,pb.length);i++){const x=pa[i]||0,y=pb[i]||0;if(x!==y)return x>y?1:-1;}
 return 0;
};
export async function checkForUpdate({repo,current}){
 if(!repo||!repo.includes('/')||/yourname|your-name|owner\//.test(repo))return {skipped:true};
 try{
  const res=await fetch(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{'User-Agent':'purchase-desk','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(8000)});
  if(res.status===404)return {error:true,status:404,message:'仓库或发布不存在'};
  if(!res.ok)return {error:true,status:res.status,message:'HTTP '+res.status};
  const j=await res.json(),latest=String(j.tag_name||'').replace(/^v/,'');
  if(!latest)return {error:true,message:'尚无发布版本'};
  return {latest,hasUpdate:cmp(latest,current)>0,url:j.html_url||'',name:j.name||'',notes:j.body||''};
 }catch(e){return {error:true,message:e.message||String(e)};}
}
