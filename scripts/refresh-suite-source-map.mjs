// A frontend-only rebuild may reuse fresh business artifacts only after proving
// both the original signed source snapshot and the current actual runtime inputs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {createPrivateKey,sign} from 'node:crypto';
import {verifyCatalog,digest,inside} from '../desktop/modules/package-format.mjs';
import {suiteSourceDigests,warehouseSourceDigest,legacyWarehouseSourceDigest} from './suite-source-digests.mjs';

const {values}=parseArgs({options:{directory:{type:'string'},'frozen-cloud-source':{type:'string'}}});
if(!values.directory||!values['frozen-cloud-source'])throw Error('Provide --directory and --frozen-cloud-source');
const root=process.cwd(),directory=path.resolve(values.directory),frozen=path.resolve(values['frozen-cloud-source']);
const dist=fs.realpathSync.native(path.join(root,'dist'))+path.sep;
for(const target of [directory,frozen])if(!fs.realpathSync.native(target).startsWith(dist)||fs.lstatSync(target).isSymbolicLink())throw Error('Only original build artifacts under this workspace dist may be rebound');
const hostVersion=JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8')).version;
const keys=JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8'));
const oldFile=path.join(directory,'catalog.json'),oldHash=await digest(oldFile),envelope=JSON.parse(fs.readFileSync(oldFile,'utf8'));
const catalog=verifyCatalog(envelope,keys,{hostVersion,platform:'win32',arch:'x64'});
if(catalog.suite?.format!=='lingtu-suite/v1'||catalog.suite.version!==hostVersion||catalog.packages.length!==7)throw Error('Expected this exact product release and seven complete signed components');
for(const spec of catalog.packages){catalog.compatible(spec);const archive=inside(directory,spec.archive);if(fs.lstatSync(archive).isSymbolicLink()||fs.statSync(archive).size!==spec.bytes||await digest(archive)!==spec.sha256)throw Error('Existing signed artifact changed: '+spec.id);}
const originalFrozen=catalog.suite.sourceFingerprintVersion===2?warehouseSourceDigest(frozen):legacyWarehouseSourceDigest(frozen);
if(originalFrozen!==catalog.suite.sourceDigests.warehouse)throw Error('Frozen cloud source does not reproduce the ORIGINAL signed source fingerprint');
const current=suiteSourceDigests(root),actualFrozen=warehouseSourceDigest(frozen);
if(current.warehouse!==actualFrozen)throw Error('Actual warehouse runtime inputs changed; a new business build is required');
for(const id of ['purchase','sales','overview','exporter'])if(current[id]!==catalog.suite.sourceDigests[id])throw Error('Application source changed; its existing ZIP cannot be reused: '+id);
const keyFile=process.env.LINGTU_MODULE_SIGNING_KEY||path.join(os.homedir(),'.codex/module-signing/lingtu-release-ed25519.pem');
if(path.resolve(keyFile).toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('Signing key must stay outside the workspace');
const key=createPrivateKey(fs.readFileSync(keyFile));if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 signing key required');
const output=fs.mkdtempSync(path.join(root,'dist/suite-payload-rebound-'));
for(const spec of catalog.packages){fs.copyFileSync(inside(directory,spec.archive),inside(output,spec.archive));fs.writeFileSync(path.join(output,spec.id+'.descriptor.json'),JSON.stringify(spec,null,2));}
const suite={...catalog.suite,sourceFingerprintVersion:2,sourceDigests:current,sourceMapProof:{format:'lingtu-source-map-rebind/v1',originalCatalogSha256:oldHash,originalWarehouseSourceDigest:originalFrozen,actualWarehouseInputDigest:actualFrozen,allBusinessArchivesUnchanged:true}};
const payload=Buffer.from(JSON.stringify({schemaVersion:1,publishedAt:new Date().toISOString(),suite,packages:catalog.packages}));
const signed={format:'lingtu-catalog/v1',keyId:envelope.keyId,payload:payload.toString('base64'),signature:sign(null,payload,key).toString('base64')};verifyCatalog(signed,keys,{hostVersion,platform:'win32',arch:'x64'});
fs.writeFileSync(path.join(output,'catalog.json'),JSON.stringify(signed,null,2));
fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify({...suite,catalogSha256:await digest(path.join(output,'catalog.json')),packages:catalog.packages.map(({id,version,archive,bytes,unpackedBytes,sha256})=>({id,version,archive,bytes,unpackedBytes,sha256}))},null,2));
fs.writeFileSync('dist/suite-payload-current.json',JSON.stringify({directory:output,version:hostVersion,catalogSha256:await digest(path.join(output,'catalog.json'))},null,2));
console.log(JSON.stringify({directory:output,version:hostVersion,allBusinessArchivesUnchanged:true,originalCatalogSha256:oldHash,actualWarehouseInputDigest:actualFrozen}));
