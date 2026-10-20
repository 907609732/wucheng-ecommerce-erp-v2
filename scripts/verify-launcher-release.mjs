import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const tag=process.argv[2]||'v0.8.0';
const folder=path.resolve('dist/launcher-release');
const release=JSON.parse(execFileSync('gh',['release','view',tag,'--json','assets,isDraft,url'],{encoding:'utf8'}));
const expected=fs.readFileSync(path.join(folder,'SHA256SUMS.txt'),'utf8').trim().split(/\r?\n/).map(line=>{
  const [,sha,name]=line.match(/^([a-f0-9]{64})\s+(.+)$/);
  return {name,sha};
});
for(const item of expected){
  const asset=release.assets.find(x=>x.name===item.name);
  assert.ok(asset,'Missing asset: '+item.name);
  assert.equal(asset.state,'uploaded');
  assert.equal(asset.size,fs.statSync(path.join(folder,item.name)).size);
  assert.equal(asset.digest,'sha256:'+item.sha,item.name+' remote digest');
}
const report={ok:true,tag,draft:release.isDraft,remoteAssetHashesVerified:expected.length,checkedAt:new Date().toISOString()};
if(process.argv.includes('--public')){
  assert.equal(release.isDraft,false);
  for(const item of expected){
    const url=`https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/${tag}/${item.name}`;
    const response=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(60000)});
    assert.equal(response.status,200,item.name+' public URL');
    assert.equal(Number(response.headers.get('content-length')),fs.statSync(path.join(folder,item.name)).size);
  }
  const installer=expected.find(x=>x.name.includes('-Setup-')&&x.name.endsWith('.exe'));
  const response=await fetch(`https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/${tag}/${installer.name}`,{signal:AbortSignal.timeout(600000)});
  assert.equal(response.status,200);
  const hash=createHash('sha256');for await(const chunk of response.body)hash.update(chunk);
  assert.equal(hash.digest('hex'),installer.sha);
  report.publicUrlsReachable=expected.length;
  report.fullInstallerDownloadVerified=true;
}
fs.writeFileSync('dist/module-verification/release-assets.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
