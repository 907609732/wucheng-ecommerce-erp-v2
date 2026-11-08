// fnpack aligns fields and adds its app.tgz MD5. Every source value must remain
// unchanged; SHA256 byte checks cover all other payload/metadata files.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {manifestFields} from './verify-artifact.mjs';
const [source,packed,archive]=process.argv.slice(2);
try{
 const expected=manifestFields(fs.readFileSync(source,'utf8')),bytes=fs.readFileSync(packed),actual=manifestFields(bytes.toString('utf8'));
 for(const [key,value] of Object.entries(expected))assert.equal(actual[key],value,'Official packed manifest changed '+key);
 for(const key of Object.keys(actual))assert(Object.hasOwn(expected,key)||key==='checksum','Unexpected packed manifest field '+key);
 assert(/^[0-9a-f]{32}$/i.test(actual.checksum),'Official app archive checksum missing');
 const hash=createHash('md5');for await(const chunk of fs.createReadStream(archive))hash.update(chunk);
 assert.equal(actual.checksum.toLowerCase(),hash.digest('hex'),'Official app.tgz checksum differs');
 console.log(JSON.stringify({ok:true,sourceFields:Object.keys(expected).length,packedManifestSHA256:createHash('sha256').update(bytes).digest('hex'),officialAppArchiveMD5:actual.checksum}));
}catch(error){console.error(error.message);process.exitCode=1;}
