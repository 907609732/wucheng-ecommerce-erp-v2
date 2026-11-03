import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {developmentConfig} from '../server/config.mjs';

test('user uploader runs independently, refuses duplicate agent, and closes cleanly',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-version-agent-'));
  const file=path.join(dir,'config.json'),config=developmentConfig({stateDir:dir});
  config.dataVersion={enabled:true,dir:path.join(dir,'versions'),workspace:path.join(dir,'versions','workspace'),cmPath:process.execPath,repository:'synthetic@local',uploadMode:'user-agent'};
  fs.writeFileSync(file,JSON.stringify(config));
  let ticks=0,closes=0;
  const {createUploadAgent}=await import('../server/data-version/agent.mjs');
  const factory=()=>({tick:async()=>{ticks++;},close:async()=>{closes++;}});
  const agent=await createUploadAgent({configFile:file,workerFactory:factory,intervalMs:50});
  t.after(async()=>{await agent.stop();fs.rmSync(dir,{recursive:true,force:true});});
  await agent.start();
  assert.equal(ticks,1);
  await assert.rejects(createUploadAgent({configFile:file,workerFactory:factory}),/已在运行/);
  await agent.stop();
  assert.equal(closes,1);
  assert(!fs.existsSync(path.join(config.dataVersion.dir,'user-agent-runtime.json')));
});
