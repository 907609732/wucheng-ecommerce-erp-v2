import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {browserOperation as sales} from '../apps/sales/lib/agent-cainiao-page.mjs';
import {browserOperation as overview} from '../apps/overview/lib/cainiao-page.mjs';

// This controlled Page fixture models event ordering, including an unrelated
// manual download arriving before the owner download. No platform is accessed.
function fixture(popupDownload){
 const context=new EventEmitter(),page=new EventEmitter(),sibling=new EventEmitter(),popup=new EventEmitter();
 const pages=[page,sibling],task={id:'123',name:'fixture-task',account:'cn-fixture',basis:'业务时间',status:'已完成',page:1};
 context.pages=()=>pages;page.context=()=>context;page.url=()=> 'https://b.cainiao.com/cf_seller/workbench';page.goto=async()=>{};
 page.evaluate=async()=>'';page.waitForTimeout=ms=>new Promise(resolve=>setTimeout(resolve,Math.min(ms,5)));
 const locator={filter(){return this;},first(){return this;},last(){return this;},async waitFor(){},async count(){return 0;},async isEnabled(){return false;},async click(){},async innerText(){return 'cn-fixture 绑定支付宝账号';}};
 const download=name=>({async saveAs(){},async failure(){return null;},suggestedFilename:()=>name});
 const row={async allTextContents(){return ['2026-01-01',task.name,task.id,task.account,task.basis,task.status,'下载'];},getByRole(){return {async allTextContents(){return row.allTextContents();},async click(){
   sibling.emit('download',download('other-account.csv'));
   if(popupDownload){pages.push(popup);context.emit('page',popup);page.emit('popup',popup);}
   setTimeout(()=> (popupDownload?popup:page).emit('download',download('owner.csv')),2);
 }}}};
 page.locator=()=>locator;page.getByText=()=>locator;page.getByRole=(role,args)=>role==='row'?{...locator,async all(){return [row];},filter(){return row;}}:locator;
 return {page,sibling,popup,context,task};
}
for(const [module,operation] of [['sales',sales],['overview',overview]])for(const popupDownload of [false,true]){
 test(`${module}: ignores sibling downloads and captures ${popupDownload?'owned popup':'owned page'} only`,async()=>{
  const f=fixture(popupDownload);
  const result=await operation(f.page,{op:'download',account:'cn-fixture',task:f.task,target:'fixture.part'});
  assert.equal(result.filename,'owner.csv');
  for(const p of [f.page,f.sibling,f.popup]){assert.equal(p.listenerCount('download'),0);assert.equal(p.listenerCount('popup'),0);}
  assert.equal(f.context.listenerCount('page'),0);
 });
}
