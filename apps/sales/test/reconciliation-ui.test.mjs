import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Run the shipped browser module in a fresh browser-like scope for each test.
// Only the ESM export declaration is removed; rendering and click handlers are real.
const source=readFileSync(new URL('../public/pdd-ui.js',import.meta.url),'utf8');
const script=new vm.Script(source.replace(/^export function createPddUI\(/m,'function createPddUI(')+'\ncreatePddUI;',{
  filename:'apps/sales/public/pdd-ui.js'
});
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>value==null?'—':(value/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});

function monthData(patch={}){
  return {
    month:'2026-08',income:123400,expense:-11100,net:112300,count:3,income_count:2,expense_count:1,
    groups:[{name:'交易收入',direction:'income',count:2,amount:123400},{name:'退款',direction:'expense',count:1,amount:-11100}],
    coverage:{status:'partial',sources:[{id:'original-august',filename:'合成测试八月账单.csv'}],intervals:[],gaps:[{start:'2026-08-20',end:'2026-08-31'}]},
    comparison:'no_reference',reference:null,...patch
  };
}

function harness({hash='#reconciliation?shop_id=all&month=2026-08',months=[monthData(),monthData({month:'2026-09',income:98765400})]}={}){
  const nodes=new Map(),listeners=new Map(),requests=[],tables=[],dialogs=[];
  const $=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',value:'',classList:{add(){},remove(){}}});
    return nodes.get(selector);
  };
  const location={hash};
  const document={
    addEventListener(type,handler){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(handler);},
    getElementById(id){return $('#'+id);}
  };
  class Tabulator{
    constructor(selector,options){this.selector=selector;this.options=options;tables.push(this);}
    on(){}
    destroy(){this.destroyed=true;}
  }
  const createPddUI=script.runInNewContext({document,location,URLSearchParams,Tabulator});
  const boot={month:'2026-09',shops:[
    {id:'pdd-test',platform:'拼多多',name:'合成测试拼多多'},
    {id:'tb-test',platform:'淘宝',name:'合成测试淘宝'},
    {id:'offline',platform:'线下',name:'线下销售',manual:true},
    {id:'ozon-test',platform:'Ozon',name:'合成测试 Ozon'}
  ]};
  const state={shop:'all',period:boot.month,grain:'month'};
  const api=async raw=>{
    requests.push(raw);const url=new URL(raw,'http://127.0.0.1');
    if(url.pathname==='/api/pdd/unassigned')return [];
    if(['/api/pdd/statement','/api/taobao/statement'].includes(url.pathname)){
      const shopId=url.searchParams.get('shop_id');
      return {year:url.searchParams.get('year'),shop_id:shopId,shop:boot.shops.find(shop=>shop.id===shopId)?.name,months:structuredClone(months)};
    }
    if(['/api/pdd/movements','/api/taobao/movements'].includes(url.pathname))return {
      attribution:'confirmed',from:'2026-08-01',to:'2026-08-31',total:0,page:1,page_size:50,
      rows:[],facets:{categories:[],batches:[]},totals:{income:0,expense:0,net:0}
    };
    throw Error('Unexpected UI request: '+raw);
  };
  const ui=createPddUI({$,boot,state,api,esc:escapeHtml,money,number:value=>value==null?'—':String(value),
    dialog(title,html){dialogs.push({title,html});},toast(){},render(){},upload(){throw Error('Import must be reached through the task center');}
  });
  return {ui,state,location,requests,tables,dialogs,html:()=>$('#content').innerHTML,
    async click(attribute,value=''){
      const datasetName=attribute.slice(5).replace(/-([a-z])/g,(_match,char)=>char.toUpperCase());
      const button={dataset:{[datasetName]:value},hasAttribute:name=>name===attribute};
      for(const listener of listeners.get('click')||[])await listener({target:{closest:selector=>selector==='button'?button:null}});
    }
  };
}

const currentSection=html=>html.match(/<section class="card reconciliation-current">[\s\S]*?<\/section>/)?.[0]||'';
const queryFromHash=hash=>new URLSearchParams(hash.split('?')[1]||'');

test('资金对账全店首屏只展示店铺入口，不铺开所有店铺年度表',async()=>{
  const h=harness();await h.ui.summary();const html=h.html();
  assert.equal((html.match(/class="shop-picker-card"/g)||[]).length,4);
  assert.match(html,/合成测试拼多多/);assert.match(html,/合成测试淘宝/);
  assert.match(html,/data-pdd-settlements="offline"/);assert.match(html,/data-pdd-settlements="ozon-test"/);
  assert.doesNotMatch(html,/account-month-table|reconciliation-year/);
  assert.match(html,/#reconciliation\?shop_id=pdd-test&month=2026-08/);
  assert.match(html,/本月收入/);assert.match(html,/1,234\.00/);
  assert.doesNotMatch(html,/987,654\.00/,'其他月份金额不能混入所选月份的首屏');
  assert.equal(h.state.period,'2026-08');
  assert.equal(h.requests.filter(url=>url.includes('/statement?')).length,2,'只有已接入官方账单的平台请求月表');
});

test('单店聚焦所选月份，全年表默认折叠并保留年度导出',async()=>{
  const h=harness({hash:'#reconciliation?shop_id=pdd-test&month=2026-08'});await h.ui.summary();
  const html=h.html(),current=currentSection(html),annualTag=html.match(/<details\b[^>]*class="[^"]*reconciliation-year[^>]*>/)?.[0];
  assert.match(current,/2026-08/);assert.match(current,/1,234\.00/);assert.match(current,/-111\.00/);assert.match(current,/1,123\.00/);
  assert.doesNotMatch(current,/987,654\.00/);
  assert.ok(annualTag,'单店仍可展开全年记录');assert.doesNotMatch(annualTag,/\sopen(?:\s|=|>)/);
  assert.match(html,/period=2026&grain=year&shop=pdd-test/);
  assert.match(html,/#reconciliation\?shop_id=all&month=2026-08/);
 assert.match(html,/#imports\?month=2026-08&shop_id=pdd-test/);
  assert.match(html,/#pdd-details\?shop_id=pdd-test&month=2026-08&direction=income/);
  assert.equal(h.state.period,'2026-08');assert.equal(h.state.grain,'month');
  assert.match(h.ui.exportURL(),/period=2026-08&grain=month&shop=pdd-test/);
});

test('淘宝和拼多多逐笔明细返回时保留所属店铺与核对月份',async t=>{
  for(const [route,shop]of [['pdd-details','pdd-test'],['tb-details','tb-test']])await t.test(route,async()=>{
    const h=harness({hash:`#${route}?shop_id=${shop}&month=2026-08&direction=income`});await h.ui.details();
    const back=h.html().match(/class="back-link" href="([^"]+)"/)?.[1];assert.ok(back);
    assert.ok(back.startsWith('#reconciliation?'));
    const query=queryFromHash(back);assert.equal(query.get('shop_id'),shop);assert.equal(query.get('month'),'2026-08');
    assert.equal(h.tables.length,1,'执行真实 details 渲染并创建逐笔流水表');
    assert.match(h.html(),/movements-export\?/,'保留当前筛选结果的导出入口');
  });
});

test('仅拼多多显示平台截图入口，截图默认使用所选核对月',async()=>{
  const pdd=harness({hash:'#reconciliation?shop_id=pdd-test&month=2026-08'});await pdd.ui.summary();
  assert.match(pdd.html(),/data-pdd-reference/);await pdd.click('data-pdd-reference');
  assert.equal(pdd.dialogs.length,1);assert.match(pdd.dialogs[0].html,/name="month" value="2026-08"/);
  assert.doesNotMatch(pdd.dialogs[0].html,/name="month" value="2026-09"/,'不使用 bootstrap 的默认月份覆盖当前选月');
  const tb=harness({hash:'#reconciliation?shop_id=tb-test&month=2026-08'});await tb.ui.summary();
  assert.doesNotMatch(tb.html(),/data-pdd-reference/);
});

test('手工渠道和其他未接入平台店铺进入携带店铺月份的结算核对页',async t=>{
  for(const shop of ['offline','ozon-test'])await t.test(shop,async()=>{
    const h=harness();await h.ui.summary();await h.click('data-pdd-settlements',shop);
    assert.equal(h.state.shop,shop);assert.equal(h.state.accountSettlements,true);
    const query=queryFromHash(h.location.hash);assert.ok(h.location.hash.startsWith('#reconciliation?'));
    assert.equal(query.get('shop_id'),shop);assert.equal(query.get('month'),'2026-08');assert.equal(query.get('mode'),'settlements');
  });
});

test('缺失账单保留空金额，不把未取得月份显示为零',async t=>{
  const absent=monthData({income:null,expense:null,net:null,count:null,groups:[],coverage:{status:'missing',sources:[],intervals:[],gaps:[]}});
  for(const [name,selected,months]of [['月份有条目但无账单','2026-08',[absent]],['月份未出现在年度响应','2026-07',[monthData()]]])await t.test(name,async()=>{
    const h=harness({hash:`#reconciliation?shop_id=pdd-test&month=${selected}`,months});await h.ui.summary();const current=currentSection(h.html());
    assert.match(current,/本月尚未取得账单/);assert.equal((current.match(/<strong>—<\/strong>/g)||[]).length,3);
    assert.doesNotMatch(current,/>0\.00</);assert.match(current,/#tasks\?month=/);
  });
});

test('已取得且日期完整的零流水月份仍展示真实零金额',async()=>{
  const zero=monthData({income:0,expense:0,net:0,count:0,income_count:0,expense_count:0,groups:[],coverage:{status:'full',sources:[],intervals:[],gaps:[]}});
  const h=harness({hash:'#reconciliation?shop_id=pdd-test&month=2026-08',months:[zero]});await h.ui.summary();const current=currentSection(h.html());
  assert.match(current,/已导入 0 笔/);assert.equal((current.match(/>0\.00<\/a>/g)||[]).length,3);
  assert.doesNotMatch(current,/本月尚未取得账单/);
});
