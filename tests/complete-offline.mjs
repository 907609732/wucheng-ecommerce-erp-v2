import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {digest} from '../desktop/modules/package-format.mjs';
import {ModuleManager} from '../desktop/modules/module-manager.mjs';
import {inspectBundledSuite} from '../desktop/modules/bundled-suite.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-complete-offline-'));
const hostVersion=JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8')).version;
const manager=new ModuleManager({root,hostVersion,publicKeys:JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8')),
  fetchImpl:()=>{throw Error('Offline verification forbids network');}});
const pointer=JSON.parse(fs.readFileSync('dist/suite-payload-current.json','utf8'));
const inspected=inspectBundledSuite({modules:manager,bundleDirectory:pointer.directory});
assert.equal(inspected.catalog.packages.length,5);
for(const spec of inspected.catalog.packages)assert.equal(await digest(path.join(pointer.directory,spec.archive)),spec.sha256);
const report={ok:true,officialSignature:true,allFiveArchivesVerified:true,dependencyGraphComplete:true,networkCallsAllowed:false};
fs.writeFileSync('dist/module-verification/offline.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
