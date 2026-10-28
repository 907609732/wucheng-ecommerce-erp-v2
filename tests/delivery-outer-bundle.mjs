import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractZip,digest} from '../desktop/modules/package-format.mjs';
import {ModuleManager} from '../desktop/modules/module-manager.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-delivery-bundle-'));
const hostVersion=JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8')).version;
const folder=path.resolve('dist/launcher-release'),archive=path.join(folder,`Lingtu-${hostVersion}-Complete-Offline-Windows-x64.zip`);
const expected=fs.readFileSync(path.join(folder,'SHA256SUMS.txt'),'utf8').split(/\r?\n/).find(line=>line.endsWith(path.basename(archive)))?.split(/\s+/)[0];
assert.equal(await digest(archive),expected,'Downloaded offline archive differs from its release checksum');
await extractZip(archive,path.join(root,'bundle'),{maxBytes:2*1024**3,maxEntries:10});
const installer=`CloudWarehouseInventorySync-Setup-${hostVersion}-x64.exe`;
assert.equal(await digest(path.join(root,'bundle',installer)),await digest(path.join(folder,installer)));
const manager=new ModuleManager({root:path.join(root,'verification'),hostVersion,
  publicKeys:JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8')),fetchImpl:()=>{throw Error('No network permitted');}});
const bundle=await manager.inspectOffline(path.join(root,'bundle','LingtuModules-Complete-Offline.zip'));
assert.equal(bundle.packages.length,7);
for(const name of ['workbench-tailscale.md','workbench-tailscale-acceptance.md','workbench-interface-coverage.json'])
  assert.equal(await digest(path.join(root,'bundle','文档',name)),await digest(path.join('docs',name)),'Delivery document changed: '+name);
await manager.discardOffline(bundle.token);
const result={ok:true,outerZipSha256:await digest(archive),installerIdenticalToLocallyInstalledBuild:true,
  allSevenSignedPackagesVerified:true,networkCallsAllowed:false,checkedAt:new Date().toISOString()};
fs.writeFileSync('dist/module-verification/delivery-outer.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
