import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {parseCliJsonOutput,readCliChildResult} from '../desktop/shared/cli-child-result.mjs';
import {createWorkbenchDispatcher,legacyCliArgs} from '../desktop/shared/workbench-dispatcher.mjs';

test('stdout parser accepts the complete pretty result and bounded startup logs',()=>{
  const response={ok:true,diagnostics:{checks:[{id:'synthetic',message:'中文核对'}],nested:{ready:true}}};
  const pretty=JSON.stringify(response,null,2);
  assert.deepEqual(parseCliJsonOutput(pretty+'\r\n'),response);
  assert.deepEqual(parseCliJsonOutput('\uFEFF'+pretty+'\n'),response);
  assert.deepEqual(parseCliJsonOutput('[info] initialized\r\n[notice] synthetic startup\r\n'+pretty+'\n'),response);
  assert.throws(()=>parseCliJsonOutput('{"ok":true}\ntrailing non-JSON log'),e=>e.code==='CLI_STDOUT_INVALID');
  assert.throws(()=>parseCliJsonOutput('{"ok":true,"nested":{\n}\n'),e=>e.code==='CLI_STDOUT_INVALID');
  assert.throws(()=>parseCliJsonOutput('1'),e=>e.code==='CLI_STDOUT_INVALID');
  assert.throws(()=>parseCliJsonOutput('x'.repeat(8193)+'\n'+pretty),e=>e.code==='CLI_STDOUT_INVALID');
});

function invoke(code,options){return readCliChildResult(spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe'],windowsHide:true}),options);}

test('standalone dispatcher doctor invocation preserves multiline JSON and pipe-split UTF-8',{timeout:10000},async()=>{
  const expected={ok:true,diagnostics:{message:'合成中文诊断',checks:[{id:'safe',ok:true}]}};
  const dispatch=createWorkbenchDispatcher({executeLegacy:async request=>{
    assert.deepEqual(legacyCliArgs(request),['doctor']);
    const output=Buffer.from('[info] fixture startup\n'+JSON.stringify(expected,null,2)+'\n');
    // Force a chunk boundary in the middle of a multibyte character.
    const split=output.indexOf(Buffer.from('合'))+1;
    return invoke('const b=Buffer.from('+JSON.stringify(output.toString('base64'))+',"base64");process.stderr.write("Authorization: Bearer PRIVATE_STDERR_TOKEN\\n");process.stdout.write(b.subarray(0,'+split+'));setTimeout(()=>{process.stdout.write(b.subarray('+split+'));},20);');
  }});
  assert.deepEqual(await dispatch({command:'doctor'}),expected);
});

test('child exit gates and malformed responses do not expose stderr credentials',{timeout:10000},async()=>{
  assert.deepEqual(await invoke('process.stdout.write(JSON.stringify({ok:false,code:"SYNTHETIC_REJECTION",error:"fixture rejection"},null,2));process.exitCode=1;'),{ok:false,code:'SYNTHETIC_REJECTION',error:'fixture rejection'});
  await assert.rejects(invoke('process.stdout.write(JSON.stringify({ok:true},null,2));process.exitCode=7;'),e=>e.code==='CLI_EXIT_FAILED');
  await assert.rejects(invoke('process.stderr.write("password=PRIVATE_STDERR_TOKEN\\n");process.stdout.write("malformed");'),error=>error.code==='CLI_STDOUT_INVALID'&&!JSON.stringify(error).includes('PRIVATE_STDERR_TOKEN')&&!error.message.includes('PRIVATE_STDERR_TOKEN'));
  await assert.rejects(invoke('process.stdout.write("x".repeat(500));',{maxBytes:100}),e=>e.code==='CLI_STDOUT_TOO_LARGE');
});
