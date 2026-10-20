import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import yazl from 'yazl';
import nativeFs from '../desktop/modules/native-fs.mjs';
import {extractZip,digest} from '../desktop/modules/package-format.mjs';
if(process.versions.electron){
  const [, , , root]=process.argv;
  await extractZip(path.join(root,'package.zip'),path.join(root,'unpacked'),{maxBytes:1024});
  assert.equal(nativeFs.readFileSync(path.join(root,'unpacked/resources/app.asar'),'utf8'),'opaque Electron archive bytes');
  await digest(path.join(root,'unpacked/resources/app.asar'));
  console.log(JSON.stringify({ok:true,electronRuntime:true,nestedAsarWrittenAsRawFile:true}));
}else{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-asar-extraction-'));
  const zip=new yazl.ZipFile();zip.addBuffer(Buffer.from('opaque Electron archive bytes'),'resources/app.asar');zip.end();
  await pipeline(zip.outputStream,fs.createWriteStream(path.join(root,'package.zip')));
  const result=spawnSync(path.resolve('node_modules/electron/dist/electron.exe'),[fileURLToPath(import.meta.url),'--child',root],
    {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
}
