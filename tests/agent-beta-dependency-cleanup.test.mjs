import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prunePublicDependencyFixtures} from '../scripts/agent-beta-stage.mjs';

const root=path.resolve(import.meta.dirname,'..'),stageBase=path.join(root,'dist/agent-beta/stages');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){fs.mkdirSync(stageBase,{recursive:true});const directory=fs.mkdtempSync(path.join(stageBase,'dependency-cleanup-test-'));t.after(()=>{const resolved=fs.realpathSync(directory),relative=path.relative(stageBase,resolved);assert(relative.startsWith('dependency-cleanup-test-')&&!relative.includes(path.sep)&&!path.isAbsolute(relative));fs.rmSync(resolved,{recursive:true,force:true});});return directory;}
function put(directory,relative,bytes){const file=path.join(directory,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;}
function dependency(base,relative,name,version){const directory=path.join(base,'node_modules',relative);put(directory,'package.json',JSON.stringify({name,version}));put(directory,'LICENSE','preserve this license');put(directory,'lib/runtime.js','export const production=true;');return directory;}
function approved(directory,pkgName,relative){return put(directory,relative,fs.readFileSync(path.join(root,'node_modules',pkgName,relative)));}

test('reviewed nested documentation/tests are removed while runtime, licenses and unknown entries survive',t=>{
 const base=fixture(t),dotenv=dependency(base,'dotenv','dotenv','16.6.1'),wrapper=dependency(base,'wrapper','wrapper','1.0.0');
 const classic='src/v4/classic/tests/string.test.ts',mini='src/v4/mini/tests/string.test.ts';
 const zod=dependency(wrapper,'zod','zod','4.6.5'),second=dependency(base,'another-zod','zod','4.6.7'),fastify=dependency(base,'fastify','fastify','5.12.5');
 const deleted=[approved(dotenv,'dotenv','README.md'),approved(dotenv,'dotenv','README-es.md'),approved(zod,'zod',classic),approved(zod,'zod',mini),approved(second,'zod',classic),approved(second,'zod',mini),approved(fastify,'fastify','test/upgrade.test.js')];
 const extra=put(zod,'src/v4/mini/tests/unreviewed.test.ts','unknown fixture must survive'),runtime=path.join(zod,'lib/runtime.js'),license=path.join(dotenv,'LICENSE'),before=[sha(extra),sha(runtime),sha(license)];
 const removed=prunePublicDependencyFixtures(base);assert.equal(removed.length,7);assert(removed.every(row=>/^[a-f0-9]{64}$/.test(row.sha256)&&row.package&&row.version));for(const file of deleted)assert.equal(fs.existsSync(file),false,file);
 assert.deepEqual([sha(extra),sha(runtime),sha(license)],before);assert.deepEqual(prunePublicDependencyFixtures(base),[]);
});
test('a later changed reviewed file blocks the complete cleanup plan without deleting earlier valid files',t=>{
 const base=fixture(t),first=dependency(base,'a-docs','dotenv','16.6.1'),later=dependency(base,'z-tests','zod','4.6.5'),valid=approved(first,'dotenv','README.md'),changed=approved(later,'zod','src/v4/mini/tests/string.test.ts');fs.appendFileSync(changed,'\nchanged bytes');const before=[sha(valid),sha(changed)];
 assert.throws(()=>prunePublicDependencyFixtures(base),/bytes require review/);assert.deepEqual([sha(valid),sha(changed)],before);
});
test('unknown package versions cannot delete otherwise identical reviewed documentation',t=>{
 const base=fixture(t),directory=dependency(base,'dotenv','dotenv','16.6.2'),file=approved(directory,'dotenv','README.md'),before=sha(file);assert.throws(()=>prunePublicDependencyFixtures(base),/version requires review/);assert.equal(sha(file),before);
});
test('the original exact Fastify fixture rule works nested and rejects an extra unreviewed file',t=>{
 const base=fixture(t),wrapper=dependency(base,'wrapper','wrapper','1.0.0'),directory=dependency(wrapper,'@fastify/reply-from','@fastify/reply-from','12.8.0'),source=path.join(root,'node_modules/@fastify/reply-from/test/fixtures');
 for(const name of fs.readdirSync(source))put(directory,'test/fixtures/'+name,fs.readFileSync(path.join(source,name)));
 const unexpected=put(directory,'test/fixtures/unreviewed.txt','keep unknown file');assert.throws(()=>prunePublicDependencyFixtures(base),/Unexpected dependency fixture/);assert.equal(fs.existsSync(unexpected),true);assert.equal(fs.readdirSync(path.join(directory,'test/fixtures')).length,6);
 fs.unlinkSync(unexpected);const runtime=sha(path.join(directory,'lib/runtime.js'));const removed=prunePublicDependencyFixtures(base);assert.equal(removed.length,5);assert.equal(fs.existsSync(path.join(directory,'test/fixtures')),false);assert.equal(sha(path.join(directory,'lib/runtime.js')),runtime);assert.equal(fs.existsSync(path.join(directory,'LICENSE')),true);
});
test('dependency cleanup refuses source workspaces and other paths outside the isolated stage root',()=>{
 assert.throws(()=>prunePublicDependencyFixtures(root),/escapes/);assert.throws(()=>prunePublicDependencyFixtures(stageBase),/escapes/);
});
