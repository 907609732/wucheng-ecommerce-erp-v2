import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {browserOperation,CainiaoBrowser} from '../lib/cainiao-browser.mjs';

// This is an isolated browser fixture. Every request is intercepted, and no real
// Cainiao session, account, export task or external service is accessed.
const nav='<a href="/cf_seller/bill-detail-downloads-query">下载任务查询</a>';
const billHTML=`<!doctype html><meta charset="utf-8">${nav}
<input id="statType" role="combobox"><div id="option" hidden>业务时间</div><input placeholder="起始日期"><input placeholder="结束日期"><button id="query">查询</button><button id="reset">重置</button>
<button role="tab" id="transactions">交易明细账单632</button><button role="tab" id="fees">By费用项汇总13</button><p id="summary"></p><p id="selection"></p><table><thead><tr><td><input type="checkbox" id="all"></td><td>费用项</td><td>账单类型</td><td>菜鸟主体</td><td>计费金额</td><td>支付金额</td><td>服务产品</td><td>物流商品</td><td>主单行数量</td></tr></thead><tbody id="rows"></tbody></table><button id="next">下一页，当前第1页</button><button id="download">下载</button><button id="trade">下载查询结果</button><button id="warehouse">仓储费明细下载</button><div id="dialog"></div>
<script>
let kind='transactions',page=1,selected=new Set();const names=Array.from({length:13},(_,i)=>'费用'+i);names[2]='赔付';names[10]='零金额包装';const $=id=>document.getElementById(id);
function render(){ $('summary').textContent='搜索结果数: '+(kind==='fees'?13:632)+' 计费金额: 1,535.13 CNY';$('selection').textContent='选中 '+selected.size+' 项 / 共 13 项';$('next').textContent='下一页，当前第'+page+'页';$('next').disabled=page===2;$('all').checked=false;$('rows').innerHTML=names.slice((page-1)*10,page*10).map((n,i)=>'<tr><td><input type="checkbox"></td><td>'+n+'</td><td>正常</td><td>主体</td><td>'+ (n==='赔付'?'-44.80':n==='零金额包装'?'0.00':'10.00') +' CNY</td><td>0 CNY</td><td>产品</td><td>物流</td><td>1</td></tr>').join('');}
$('statType').onclick=()=>{$('option').hidden=false};$('option').onclick=()=>{$('option').hidden=true};$('reset').onclick=()=>{selected.clear();page=1;render()};$('query').onclick=render;$('transactions').onclick=()=>{kind='transactions';page=1;render()};$('fees').onclick=()=>{kind='fees';page=1;render()};$('next').onclick=()=>{page++;render()};$('all').onchange=()=>{names.slice((page-1)*10,page*10).forEach(n=>selected.add(n));$('selection').textContent='选中 '+selected.size+' 项 / 共 13 项'};
function show(title,labels,type){$('dialog').innerHTML='<h1>'+title+'</h1>'+labels.map(n=>'<label><input type="checkbox" checked>'+n+'</label>').join('')+(type==='warehouse'?'<input placeholder="请选择月">':'')+'<button id="confirm">确定</button>';$('confirm').onclick=async()=>{await fetch('/__fixture/submit?type='+type);$('dialog').innerHTML='下载任务成功提交！'};}
$('trade').onclick=()=>show('账单下载配置',['交易账单','货品信息','计费明细'],'transactions');$('download').onclick=()=>show('费用项下载',['费用项汇总','计费明细'],'fees');$('warehouse').onclick=()=>show('选择下载月份',[],'warehouse');render();
</script>`;
test('浏览器适配：隔离 Chrome 验证日期填写、13 项跨页全选、同名任务和真实下载事件',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cn-browser-test-')),browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),tasks=[];
 try{
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());let body='';
   if(url.pathname==='/__fixture/submit'){const type=url.searchParams.get('type');tasks.push({id:String(100+tasks.length),name:type==='warehouse'?'202609商家仓储费明细下载任务':'明细账单下载任务_交易明细账单_20260901_20260930',type});return route.fulfill({contentType:'text/plain',body:'ok'});}
   if(url.pathname==='/__fixture/download')return route.fulfill({contentType:'application/octet-stream',headers:{'Content-Disposition':'attachment; filename="fixture.csv"'},body:'费用项,计费金额\n赔付,-44.80\n包装,0'});
   if(url.pathname.endsWith('workbench'))body=nav+'<p>cn-test</p><span>绑定支付宝账号</span><div id="extension-overlay"></div><script>document.getElementById("extension-overlay").attachShadow({mode:"open"}).appendChild(document.createElement("body"));</script>';
   else if(url.pathname.endsWith('merchant-counter-bill-manage'))body=billHTML;
   else if(url.pathname.endsWith('bill-detail-downloads-query'))body=nav+'<button>查询</button><button>重置</button><table><tr><td>邮件发送时间</td><td>任务名称</td><td>任务ID</td><td>发起人</td><td>查询维度</td><td>任务状态</td><td>操作</td></tr>'+tasks.map(t=>'<tr><td>2026-10-19</td><td>'+t.name+'</td><td>'+t.id+'</td><td>cn-test</td><td>业务时间</td><td>已完成</td><td><button onclick="location.href=\'/__fixture/download\'">下载</button></td></tr>').join('')+'</table>';
   return route.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  assert.equal(page.url(),'about:blank');assert.equal((await browserOperation(page,{op:'account'})).account,'cn-test');assert.equal(await page.locator('body').count(),2);
  const args={account:'cn-test',month:'2026-09',from:'2026-09-01',to:'2026-09-30',type:'fees'};
  const expected=await browserOperation(page,{op:'prepare',...args});assert.equal(expected.feeNames.length,13);assert.equal(expected.feeRows.length,13);assert.equal(expected.count,13);assert.ok(expected.feeNames.includes('赔付'));assert.ok(expected.feeNames.includes('零金额包装'));assert.equal(expected.amountCents,153513);
  const result=await browserOperation(page,{op:'submit',...args,expected,target:path.join(dir,'direct')});assert.equal(result.submitted,true);
  const list=await browserOperation(page,{op:'tasks',account:'cn-test'});assert.equal(list.length,1);
  const file=await browserOperation(page,{op:'download',account:'cn-test',task:list[0],target:path.join(dir,'result.part')});assert.equal(file.filename,'fixture.csv');assert.match(fs.readFileSync(path.join(dir,'result.part'),'utf8'),/-44.80/);
  await assert.rejects(browserOperation(page,{op:'account',account:'other'}),/ACCOUNT_CHANGED/);
 }finally{await browser.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('MCP 工具调用只嵌入固定适配器，参数作为 JSON，解析结构化结果',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cn-mcp-test-')),b=new CainiaoBrowser(dir);try{let called;b.client={callTool:async x=>{called=x;return {content:[{type:'text',text:'### Result\n{"account":"cn-test"}\n### Ran Playwright code\nexample'}]};}};assert.deepEqual(await b.run('account',{account:'cn-test'}),{account:'cn-test'});assert.equal(called.name,'browser_run_code_unsafe');assert.match(called.arguments.code,/固定|NEEDS_LOGIN/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
