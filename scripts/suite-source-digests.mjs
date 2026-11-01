import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const suiteSourceExcluded=/(^|\/)(?:node_modules|data|private|backups?|originals|attachments|\.env[^/]*|\.git|\.plastic|out|release|dist)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|pem|key|pfx)$/i;
export function suiteSourceDigest(directory,{exclude=()=>false}={}){
 const rows=[];
 function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,item.name),relative=path.relative(directory,file).replaceAll('\\','/');if(suiteSourceExcluded.test(relative)||exclude(relative))continue;if(item.isSymbolicLink())throw Error('Source fingerprint contains a link');if(item.isDirectory())walk(file);else rows.push(relative+'\0'+createHash('sha256').update(fs.readFileSync(file)).digest('hex'));}}
 walk(directory);return createHash('sha256').update(rows.join('\n')).digest('hex');
}
function cloudDigest(root,exclude){
 const cloudInputs=[suiteSourceDigest(path.join(root,'core')),suiteSourceDigest(path.join(root,'desktop'),{exclude})];
 for(const file of ['package.json','package-lock.json','config.json'])cloudInputs.push(file+'\0'+createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'));
 return createHash('sha256').update(cloudInputs.join('\n')).digest('hex');
}
// Exact first-party inputs admitted by the cloud builder's files whitelist.
// Frontend-only workbench changes must not force a new warehouse binary.
export function warehouseSourceDigest(root){return cloudDigest(root,relative=>
 /^(?:launcher|workbench-client|workbench-migration|invoice-module)(?:\/|$)/.test(relative)||
 /^shared\/cli-child-result\.mjs$/.test(relative)||
 /^workbench\/(?:gateway|server|store|manifest|policy)\.mjs$/.test(relative)||
 /^modules\/(?:module-manager|package-format|service-lifecycle|electron-lifecycle|bundled-suite)\.mjs$/.test(relative));}
export function legacyWarehouseSourceDigest(root){return cloudDigest(root,()=>false);}
export function suiteSourceDigests(root){
 const sources={};for(const id of ['purchase','sales','overview','exporter'])sources[id]=suiteSourceDigest(path.join(root,'apps',id));
 sources.warehouse=warehouseSourceDigest(root);
 return sources;
}
