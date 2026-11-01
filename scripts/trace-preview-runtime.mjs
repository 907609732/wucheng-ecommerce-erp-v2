import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),nft=require(path.join(process.env.APPDATA,'npm/node_modules/@vercel/nft'));
const [inputFile,snapshotArg,outputArg]=process.argv.slice(2);if(!inputFile||!snapshotArg||!outputArg)throw Error('Usage: node scripts/trace-preview-runtime.mjs verified-inputs.json snapshot output-directory');const evidence=path.resolve(outputArg),inputs=JSON.parse(fs.readFileSync(inputFile)),snapshot=path.resolve(snapshotArg),base=path.join(snapshot,'resources/agent-runtime');fs.mkdirSync(evidence,{recursive:true});
const prefix='resources/agent-runtime/',entries=[];
for(const item of inputs.inventory){if(!item.path.startsWith(prefix))continue;const rel=item.path.slice(prefix.length);if(rel.includes('node_modules/')||!/[.](mjs|cjs|js)$/.test(rel))continue;
 if(rel.startsWith('apps/exporter/')){if(['apps/exporter/src/main/agent-adapter.mjs','apps/exporter/out/main/preview-ledger.js'].includes(rel))entries.push(path.join(base,rel));continue;}
 if(/^apps\/[^/]+\/public\//.test(rel)||rel.startsWith('desktop/renderer/')||rel.includes('/vendor/'))continue;
 if(rel.startsWith('desktop/launcher/')&&!['desktop/launcher/main.mjs','desktop/launcher/diagnostics.mjs','desktop/launcher/component-dispatch.mjs','desktop/launcher/packaged-entry.mjs'].includes(rel))continue;
 entries.push(path.join(base,rel));
}
const started=Date.now();console.log(JSON.stringify({tool:'@vercel/nft',version:'1.11.0',entries:entries.length}));
const trace=await nft.nodeFileTrace(entries,{base,processCwd:base,mixedModules:true,moduleSyncCatchall:true,fileIOConcurrency:128,resolve:(id,parent,job,cjs)=>id==='electron'?'node:electron':nft.resolve(id,parent,job,cjs)});
const files=new Set([...trace.fileList].map(file=>file.replaceAll('\\','/'))),kept=[],removed=[],groups={};
for(const item of inputs.inventory){const rel=item.path.startsWith(prefix)?item.path.slice(prefix.length):null;const dependency=rel?.split('/').includes('node_modules');const license=/(?:^|\/)(?:licen[cs]e|notice|copying|copyright)(?:[.-][^/]*)?$/i.test(item.path);
 const retain=!dependency||files.has(rel)||license;(retain?kept:removed).push(item);
 if(dependency){const group=rel.match(/^(apps\/[^/]+\/node_modules|node_modules)/)?.[1]||'other';const g=groups[group]??={before:0,after:0,bytesRemoved:0};g.before++;if(retain)g.after++;else g.bytesRemoved+=item.bytes;}
}
const report={tool:'@vercel/nft',version:'1.11.0',base,entries:entries.map(x=>path.relative(base,x).replaceAll('\\','/')),elapsedMs:Date.now()-started,traceFiles:files.size,warnings:[...trace.warnings].map(w=>w.message),groups,beforeFiles:inputs.inventory.length,afterFiles:kept.length,removedFiles:removed.length,removedBytes:removed.reduce((s,x)=>s+x.bytes,0)};
fs.writeFileSync(path.join(evidence,'nft-trace-report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(evidence,'nft-trace-files.json'),JSON.stringify([...files].sort()));fs.writeFileSync(path.join(evidence,'nft-prune-candidates.json'),JSON.stringify(removed,null,2));console.log(JSON.stringify({...report,entries:report.entries.length,warnings:report.warnings.slice(0,15)}));
