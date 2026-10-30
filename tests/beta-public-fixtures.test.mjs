import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prunePublicDependencyFixtures} from '../scripts/agent-beta-stage.mjs';

const stageBase=path.resolve('dist/agent-beta/stages');
function fixture(t){
 fs.mkdirSync(stageBase,{recursive:true});
 const stage=fs.mkdtempSync(path.join(stageBase,'fixture-prune-')),pkg=path.join(stage,'node_modules/@fastify/reply-from'),fixtures=path.join(pkg,'test/fixtures');
 t.after(()=>{assert.equal(path.dirname(path.resolve(stage)),stageBase);fs.rmSync(stage,{recursive:true,force:true});});
 fs.mkdirSync(fixtures,{recursive:true});
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@fastify/reply-from',version:'12.8.0'}));
 fs.writeFileSync(path.join(pkg,'index.js'),'module.exports = {}');
 fs.writeFileSync(path.join(pkg,'LICENSE'),'preserve this license');
 for(const name of ['fastify.cert','fastify.key','file.txt','localhost.cert','localhost.key'])fs.writeFileSync(path.join(fixtures,name),'public test fixture');
 return {stage,pkg,fixtures};
}

test('public staging removes only reviewed TLS test fixtures and preserves production code and license',t=>{
 const {stage,pkg,fixtures}=fixture(t),removed=prunePublicDependencyFixtures(stage);
 assert.equal(removed.length,5);assert.ok(removed.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
 assert.equal(fs.existsSync(fixtures),false);
 assert.equal(fs.readFileSync(path.join(pkg,'index.js'),'utf8'),'module.exports = {}');
 assert.equal(fs.readFileSync(path.join(pkg,'LICENSE'),'utf8'),'preserve this license');
 assert.deepEqual(prunePublicDependencyFixtures(stage),[]);
});

test('unexpected fixture contents fail closed before any file is removed',t=>{
 const {stage,fixtures}=fixture(t);fs.writeFileSync(path.join(fixtures,'unexpected.txt'),'keep');
 assert.throws(()=>prunePublicDependencyFixtures(stage),/Unexpected dependency fixture entries/);
 assert.equal(fs.readdirSync(fixtures).length,6);
});

test('an unreviewed dependency version fails closed',t=>{
 const {stage,pkg,fixtures}=fixture(t);fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@fastify/reply-from',version:'99.0.0'}));
 assert.throws(()=>prunePublicDependencyFixtures(stage),/requires review/);assert.equal(fs.readdirSync(fixtures).length,5);
});

test('cleanup cannot target a dependency tree outside isolated staging',t=>{
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'outside-public-fixture-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(outside)),path.resolve(os.tmpdir()));fs.rmSync(outside,{recursive:true,force:true});});
 assert.throws(()=>prunePublicDependencyFixtures(outside),/escapes allowed root/);
});
