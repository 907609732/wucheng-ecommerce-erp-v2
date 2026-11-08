import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusInfo, displayChangeset, listQuery, hostingError, displayCount, attachmentName } from '../server/public/data-versions.js';

test('reset button does not shadow the native form reset method and clears active filters', async () => {
  const html = fs.readFileSync(new URL('../server/public/data-versions.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../server/public/data-versions.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  const nodes = new Map(), requests = [], values = {actor:'测试成员',module:'sales'};
  const element = () => ({listeners:{},classList:{toggle(){},remove(){}},addEventListener(type, callback){this.listeners[type]=callback;}});
  const get = selector => {if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);};
  const form=get('#filters');form.reset=()=>{values.actor='';values.module='';};
  // HTML form named access exposes descendant button ids as form properties.
  const formHtml = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/)[0];
  for (const match of formHtml.matchAll(/<button\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)/g)) {
    form[match[1]]=get('#'+match[1]);
    if (match[2]==='重置') nodes.set('reset-button',get('#'+match[1]));
  }
  const document={hidden:true,querySelector:get,addEventListener(){}};
  vm.runInNewContext(source,{document,window:{addEventListener(){}},URLSearchParams,AbortController,setTimeout:()=>1,clearTimeout(){},fetch:async url=>{requests.push(url);return{ok:true,json:async()=>url.includes('/summary')?{enabled:false}:{items:[],total:0}};}});
  assert.doesNotThrow(()=>nodes.get('reset-button').listeners.click());
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(values,{actor:'',module:''});
  const request=requests.find(url=>url.includes('?'));
  assert.ok(request);assert.equal(new URL(request,'http://localhost').searchParams.has('actor'),false);
});

test('pending and failed saves never claim a remote changeset', () => {
  assert.equal(displayChangeset({ status: 'pending', changeset: '42' }), '—');
  assert.equal(displayChangeset({ status: 'failed', changeset: '42' }), '—');
  assert.equal(displayChangeset({ status: 'submitted', changeset: '42' }), 'cs:42');
  assert.equal(displayChangeset({ status: 'submitted', changeset: 'cs:42' }), 'cs:42');
  assert.equal(displayChangeset({ status: 'submitted', changeset: 'not-confirmed' }), '—');
  assert.equal(displayChangeset({ status: 'submitted' }), '—');
  assert.match(statusInfo('failed').label, /异常/);
  assert.match(statusInfo('pending').label, /等待/);
  assert.equal(statusInfo('unknown').tone, 'pending');
  assert.equal(statusInfo('__proto__').tone, 'pending');
});

test('metadata uses safe counts, attachment names and Chinese hosting explanations', () => {
  for (const value of [null, undefined, '', ' ', NaN, Infinity, -1, 'bad']) assert.equal(displayCount(value), '0');
  assert.equal(displayCount(23), '23');
  assert.equal(attachmentName({name:'发票.pdf',path:'attachments/hash.pdf'}), '发票.pdf');
  assert.equal(attachmentName({path:'attachments/hash.pdf'}), 'attachments/hash.pdf');
  assert.match(hostingError('UVCS_UNAVAILABLE'), /托管服务.*暂不可用/);
  assert.match(hostingError('DATA_VERSION_EVENT_CHANGED'), /校验.*运维/);
  assert.doesNotMatch(hostingError('E:\\secret\\account.json'), /secret|account/);
});

test('list filters encode member input and cover complete local dates', () => {
  const query = listQuery({ module: 'sales', actor: '成员 & A', status: 'failed', from: '2026-11-01', to: '2026-11-04' }, 50);
  assert.equal(query.get('actor'), '成员 & A');
  assert.equal(query.get('module'), 'sales');
  assert.equal(query.get('status'), 'failed');
  assert.equal(query.get('limit'), '50');
  assert.equal(query.get('offset'), '50');
  assert.equal(new Date(query.get('from')).getHours(), 0);
  assert.equal(new Date(query.get('to')).getHours(), 23);
  assert.equal(new Date(query.get('to')).getMilliseconds(), 999);
  assert.equal(listQuery({}, 0).has('actor'), false);
});
