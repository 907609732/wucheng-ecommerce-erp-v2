import test from 'node:test';
import assert from 'node:assert/strict';
import {openWarehouseImportAssistant,warehouseImportPrompt} from '../public/warehouse-import-assistant.js';

function setup(t){
  const dialog={open:true},nodes=new Map(),buttons=['warehouse','merchant','sf'].map(id=>({dataset:{freightPlatform:id},setAttribute(k,v){this[k]=v;}}));
  for(const id of ['warehouse-ai-packet','warehouse-ai-copy','warehouse-ai-error','warehouse-ai-scope','warehouse-ai-ready','warehouse-ai-status','warehouse-ai-retry'])nodes.set('#'+id,{value:'',textContent:'',hidden:true,disabled:true,isConnected:true,closest:()=>dialog,focus(){this.focused=true;},select(){this.selected=true;}});
  nodes.get('#warehouse-ai-scope').value='missing';
  const originalDoc=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelectorAll:()=>buttons}});
  const originalClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});
  t.after(()=>{if(originalDoc)Object.defineProperty(globalThis,'document',originalDoc);else delete globalThis.document;if(originalClipboard)Object.defineProperty(navigator,'clipboard',originalClipboard);else delete navigator.clipboard;});
  const ctx={$:s=>nodes.get(s),esc:s=>s,dialog(){},toast(){},state:{period:'2026-10'},boot:{month:'2026-09'}};
  return {nodes,buttons,dialog,ctx};
}
const response=()=>({ok:true,text:async()=>'official skill content'});

test('late Skill response cannot expose cloud instructions after switching to a pending platform',async t=>{
  const {nodes,buttons,ctx}=setup(t);let resolve;const pending=new Promise(r=>resolve=r);t.mock.method(globalThis,'fetch',()=>pending);
  await openWarehouseImportAssistant(ctx);const loading=buttons[0].onclick();assert.match(nodes.get('#warehouse-ai-status').innerHTML,/<progress/);assert.match(nodes.get('#warehouse-ai-status').innerHTML,/data-variant="inline"/);await buttons[1].onclick();resolve(response());await loading;
  assert.equal(nodes.get('#warehouse-ai-ready').hidden,true);assert.equal(nodes.get('#warehouse-ai-copy').disabled,true);assert.equal(nodes.get('#warehouse-ai-packet').value,'');assert.match(nodes.get('#warehouse-ai-status').textContent,/商家寄件待开通/);assert.equal(buttons[1]['aria-pressed'],'true');
});

test('closing during load leaves the hidden packet untouched',async t=>{
  const {nodes,buttons,dialog,ctx}=setup(t);let resolve;const pending=new Promise(r=>resolve=r);t.mock.method(globalThis,'fetch',()=>pending);
  await openWarehouseImportAssistant(ctx);const loading=buttons[0].onclick();dialog.open=false;resolve(response());await loading;
  assert.equal(nodes.get('#warehouse-ai-packet').value,'');assert.equal(nodes.get('#warehouse-ai-ready').hidden,true);
});

test('failed Skill load can retry; clipboard refusal selects the full packet for manual copy',async t=>{
  const {nodes,buttons,ctx}=setup(t);let fail=true;t.mock.method(globalThis,'fetch',async()=>({ok:!fail,text:async()=>'official skill content'}));
  await openWarehouseImportAssistant(ctx);await buttons[0].onclick();assert.equal(nodes.get('#warehouse-ai-retry').hidden,false);assert.equal(nodes.get('#warehouse-ai-ready').hidden,true);
  fail=false;await nodes.get('#warehouse-ai-retry').onclick();assert.equal(nodes.get('#warehouse-ai-ready').hidden,false);const packet=nodes.get('#warehouse-ai-packet');
  for(const file of ['SKILL.md','references/browser.md','references/import.md'])assert.ok(packet.value.includes('===== '+file+' ====='));
  navigator.clipboard.writeText=async()=>{throw Error('denied');};await nodes.get('#warehouse-ai-copy').onclick();assert.equal(packet.selected,true);assert.equal(packet.focused,true);assert.match(nodes.get('#warehouse-ai-error').textContent,/Ctrl\+C/);
  nodes.get('#warehouse-ai-scope').value='month';nodes.get('#warehouse-ai-scope').onchange();assert.ok(packet.value.includes('本次仅处理 2026-10'));
});

test('month-scoped prompts never silently expand invalid months into another selected month',()=>{
  assert.ok(warehouseImportPrompt({month:'2026-11',scope:'month'}).includes('本次仅处理 2026-11'));
  assert.ok(!warehouseImportPrompt({month:'2026-13',scope:'month'}).includes('仅处理 2026-13'));
});
