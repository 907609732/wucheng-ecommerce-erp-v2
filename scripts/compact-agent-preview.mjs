// Usage: node scripts/compact-agent-preview.mjs verified-inputs.json
//        nft-trace-files.json nft-trace-report.json NEW-short-physical-directory
// The verified-inputs file must name the immutable, already scanned snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {compactPreview} from './preview-dependency-layers.mjs';
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
export async function compactVerifiedPreview(inputFile,traceFile,reportFile,destination){
 const input=read(inputFile),source=path.resolve(input.prepackaged),root=path.resolve(import.meta.dirname,'..');
 destination=path.resolve(destination);
 if(destination===source||destination.startsWith(source+path.sep))throw Error('Compaction requires a separate destination');
 const pin='resources/agent-runtime/agent-beta-resources.json';
 if(sha(path.join(source,pin))!==input.stageManifestSha256)throw Error('Verified source manifest differs');
 const inventory=[...input.inventory];if(input.compatibilityOverlay)inventory.push({...input.compatibilityOverlay,bytes:fs.statSync(path.join(source,input.compatibilityOverlay.path)).size});
 const layers=await compactPreview({source,destination,inventory,tracedFiles:read(traceFile),warnings:read(reportFile).warnings});
 const metrics=layers.metrics;delete layers.metrics;
 const runtime=path.join(destination,'resources/agent-runtime'),manifest=read(path.join(runtime,'agent-beta-resources.json'));
 const patches=['activation.mjs','activation-resources.mjs','preview-ledgers.mjs','resource-layout.mjs'];
 // Verify copied original files before applying the two deployment-only patches.
 for(const item of inventory){const file=path.join(destination,...item.path.split('/'));if(fs.existsSync(file)&&sha(file)!==item.sha256)throw Error('Snapshot copy differs: '+item.path);}
 for(const name of patches)fs.copyFileSync(path.join(root,'desktop/business-host',name),path.join(runtime,'desktop/business-host',name));
 function walk(dir,prefix='',files=[]){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const rel=prefix+e.name,file=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Compacted layout contains a link');if(e.isDirectory())walk(file,rel+'/',files);else files.push({path:rel,bytes:fs.statSync(file).size,sha256:sha(file)});}return files;}
 manifest.dependencyLayers=layers;manifest.payloadHashes={};
 for(const f of walk(runtime))if(!['agent-beta-resources.json','desktop/business-host/packaged-manifest.json'].includes(f.path))manifest.payloadHashes[f.path]=f.sha256;
 fs.writeFileSync(path.join(runtime,'agent-beta-resources.json'),JSON.stringify(manifest));const digest=sha(path.join(runtime,'agent-beta-resources.json'));
 fs.writeFileSync(path.join(runtime,'desktop/business-host/packaged-manifest.json'),JSON.stringify({sha256:digest}));
 const metaFile=path.join(destination,'resources/agent-preview-package.json'),meta=read(metaFile);meta.stageManifestSha256=digest;meta.deploymentOptimization={sourceManifestSha256:input.stageManifestSha256,method:'content-addressed ZIP64 dependency layers',businessCodeChanged:false};fs.writeFileSync(metaFile,JSON.stringify(meta,null,2));
 const files=walk(destination),result={source,destination,metrics,manifestSha256:digest,inventory:files,files:files.length,bytes:files.reduce((s,f)=>s+f.bytes,0)};
 fs.writeFileSync(path.join(path.dirname(destination),'optimized-layout.json'),JSON.stringify(result));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){const r=await compactVerifiedPreview(...process.argv.slice(2));console.log(JSON.stringify({...r,inventory:undefined}));}
