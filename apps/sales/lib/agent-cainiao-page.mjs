// Only this fixed adapter is executed in Playwright. No caller-provided code or URL is accepted.
export async function browserOperation(page,arg){
 const base='https://b.cainiao.com',home=base+'/cf_seller/workbench',bill=base+'/cf_seller/merchant-counter-bill-manage',tasks=base+'/cf_seller/bill-detail-downloads-query';
 const visibleText=()=>page.locator('xpath=/html/body').innerText();
 async function guard(){
  if(new URL(page.url()).origin!==base)throw Error('NEEDS_LOGIN:请选择已经登录的菜鸟金掌柜标签页');
  if(await page.getByText(/拖动滑块|请完成验证|安全验证|扫码登录|账号登录/).filter({visible:true}).count())throw Error('NEEDS_LOGIN:请先在 Chrome 完成登录或验证');
 }
 async function go(url){await guard();await page.goto(url,{waitUntil:'domcontentloaded'});await guard();}
 async function account(){
  await go(home);await page.getByRole('link',{name:'下载任务查询',exact:true}).waitFor({state:'visible',timeout:20000});
  await page.getByText('绑定支付宝账号',{exact:false}).waitFor({state:'visible',timeout:20000});
  const text=await visibleText(),m=text.match(/(?:^|\s)(cn-[^\s]+)/);if(!m)throw Error('NEEDS_LOGIN:未能确认当前菜鸟账户，请保持金掌柜首页已登录');
  if(arg.account&&arg.account!==m[1])throw Error('ACCOUNT_CHANGED:当前 Chrome 账户与下载任务不一致');return m[1];
 }
 async function settled(){await page.waitForTimeout(600);await page.getByText('加载中...',{exact:true}).waitFor({state:'hidden',timeout:20000});await page.locator('.next-loading-mask').filter({visible:true}).first().waitFor({state:'hidden',timeout:20000});await guard();}
 async function scanTasks(){
  await go(tasks);await page.getByRole('button',{name:'查询',exact:true}).waitFor({state:'visible',timeout:20000});await settled();
  await page.getByRole('button',{name:'重置',exact:true}).click();await page.getByRole('button',{name:'查询',exact:true}).click();await settled();
  const out=[];let pages=0;
  while(true){
   await settled();const rows=await page.getByRole('row').all();
   for(const row of rows){const cells=await row.getByRole('cell').allTextContents();if(cells.length>=7&&/^\d+$/.test(cells[2].trim()))out.push({time:cells[0].trim(),name:cells[1].trim(),id:cells[2].trim(),account:cells[3].trim(),basis:cells[4].trim(),status:cells[5].trim(),page:pages+1});}
   const next=page.getByRole('button',{name:/^下一页/});if(!await next.count()||!await next.isEnabled())break;
   if(++pages>=1000)throw Error('任务列表超过扫描上限，请缩小平台任务列表');await next.click();
  }return out;
 }
 async function prepare(){
  await account();await go(bill);await page.getByRole('button',{name:'重置',exact:true}).waitFor({state:'visible',timeout:20000});
  await page.getByRole('button',{name:'重置',exact:true}).click();await page.locator('#statType').click();await page.getByText('业务时间',{exact:true}).click();
  await page.getByPlaceholder('起始日期',{exact:true}).fill(arg.from);await page.getByPlaceholder('起始日期',{exact:true}).press('Enter');
  await page.getByPlaceholder('结束日期',{exact:true}).fill(arg.to);await page.getByPlaceholder('结束日期',{exact:true}).press('Enter');
  await page.getByRole('button',{name:'查询',exact:true}).click();await settled();
  if(arg.type==='fees')await page.getByRole('tab',{name:/By费用项汇总/}).click();else await page.getByRole('tab',{name:/交易明细账单/}).click();await settled();
  const txt=await visibleText(),count=txt.match(/搜索结果数[:：]\s*([\d,]+)/),amount=txt.match(/计费金额[:：]\s*([-\d,.]+)\s*CNY/);
  if(!count||!amount)throw Error('未读取到明确的查询数量和计费金额，请核对网站页面');
  const actualFrom=await page.getByPlaceholder('起始日期',{exact:true}).inputValue(),actualTo=await page.getByPlaceholder('结束日期',{exact:true}).inputValue();
  if(actualFrom!==arg.from||actualTo!==arg.to)throw Error('查询日期控件与所选业务范围不一致，停止导出');
  const expected={period:arg.month,from:actualFrom,to:actualTo,pageRangeVerified:true,count:Number(count[1].replace(/,/g,'')),amountCents:Math.round(Number(amount[1].replace(/,/g,''))*100),feeNames:[],feeRows:[]};
  if(arg.type==='fees'&&expected.count){
   let pages=0;
   while(true){
    for(const row of await page.getByRole('row').all()){const cells=await row.getByRole('cell').allTextContents();if(cells.length>=9&&await row.getByRole('checkbox').count()&&cells[1].trim()!=='费用项'){expected.feeNames.push(cells[1].trim());expected.feeRows.push(cells.slice(1).map(c=>c.trim()));}}
    await page.getByRole('checkbox').first().check();
    const next=page.getByRole('button',{name:/^下一页/});if(!await next.count()||!await next.isEnabled())break;
    if(++pages>=1000)throw Error('费用项分页超过上限');await next.click();await settled();
   }
   const text=await visibleText(),selected=text.match(/选中\s*(\d+)\s*项\s*\/\s*共\s*(\d+)\s*项/);
   if(!selected||Number(selected[1])!==expected.count||Number(selected[2])!==expected.count||expected.feeRows.length!==expected.count)throw Error('未能选中所有分页费用项，停止下载以防漏单');
  }
  return expected;
 }
 async function clickAndCapture(action){
  let resolveDownload;const found=new Promise(resolve=>{resolveDownload=resolve;});const listen=p=>p.on('download',resolveDownload);const ctx=page.context();for(const p of ctx.pages())listen(p);ctx.on('page',listen);
  try{
   await action();const result=await Promise.race([found.then(download=>({download})),page.getByText(/下载任务成功提交|无数据|暂无数据|没有可下载|邮箱|邮件配置|下载失败/).filter({visible:true}).first().waitFor({state:'visible',timeout:15000}).then(()=>({submitted:true})).catch(()=>({uncertain:true}))]);
   if(result.download){await result.download.saveAs(arg.target);return {direct:true,filename:result.download.suggestedFilename()};}
   const text=await visibleText();if(/下载任务成功提交/.test(text))return {submitted:true};
   if(/暂无数据|无数据|没有可下载/.test(text))return {empty:true,reason:'平台明确提示没有可下载数据'};
   if(/邮箱|邮件配置/.test(text))throw Error('NEEDS_ACTION:平台要求邮件配置，请手动处理；程序不会发送邮件');
   throw Error('UNCERTAIN:平台未明确返回下载任务结果，请先核对任务中心');
  }finally{ctx.off('page',listen);for(const p of ctx.pages())p.off('download',resolveDownload);}
 }
 // The official extension can connect by creating a new, empty tab. Open only
 // our fixed home URL there; never redirect an unrelated or extension page.
 if(arg.op==='account'&&page.url()==='about:blank')await page.goto(home,{waitUntil:'domcontentloaded'});
 await guard();
 if(arg.op==='account')return {account:await account()};
 if(arg.op==='tasks'){await account();return scanTasks();}
 if(arg.op==='prepare')return prepare();
 if(arg.op==='submit'){
  // Re-query immediately before export so manually changed filters never leak into an export.
  const expected=await prepare();if(JSON.stringify(expected)!==JSON.stringify(arg.expected))throw Error('查询结果已变化，请重新核对后下载');
  if(arg.type==='transactions'){
   await page.getByRole('button',{name:'下载查询结果',exact:true}).click();await page.getByRole('heading',{name:'账单下载配置',exact:true}).waitFor({state:'visible'});
   for(const name of ['交易账单','货品信息','计费明细'])await page.getByRole('checkbox',{name:new RegExp(name)}).check();
   return clickAndCapture(()=>page.getByRole('button',{name:'确定',exact:true}).last().click());
  }
  if(arg.type==='fees'){
   await page.getByRole('button',{name:'下载',exact:true}).click();await page.getByRole('heading',{name:'费用项下载',exact:true}).waitFor({state:'visible'});
   for(const name of ['费用项汇总','计费明细'])await page.getByRole('checkbox',{name:new RegExp(name)}).check();
   return clickAndCapture(()=>page.getByRole('button',{name:'确定',exact:true}).last().click());
  }
  const button=page.getByRole('button',{name:'仓储费明细下载',exact:true});if(!await button.count()||!await button.isEnabled())return {unavailable:true,reason:'平台未开放仓储明细下载'};
  await button.click();await page.getByPlaceholder('请选择月',{exact:true}).fill(arg.month);await page.getByPlaceholder('请选择月',{exact:true}).press('Enter');
  return clickAndCapture(()=>page.getByRole('button',{name:'确定',exact:true}).last().click());
 }
 if(arg.op==='download'){
  await account();const records=await scanTasks(),task=records.find(t=>t.id===arg.task.id);
  if(!task||task.name!==arg.task.name||task.account!==arg.account||task.basis!==arg.task.basis)throw Error('下载任务编号或账户不匹配');
  if(task.status!=='已完成')throw Error('WAITING:平台任务尚未完成');
  await go(tasks);await page.getByRole('button',{name:'查询',exact:true}).waitFor({state:'visible'});await settled();
  for(let p=1;p<task.page;p++){await page.getByRole('button',{name:/^下一页/}).click();await settled();}
  const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:task.id,exact:true})});
  let listener,timer;const ctx=page.context(),downloadPromise=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('下载未完成，请重新连接后继续')),45000);listener=d=>{clearTimeout(timer);resolve(d);};});downloadPromise.catch(()=>{});
  const attach=p=>p.on('download',listener);for(const p of ctx.pages())attach(p);ctx.on('page',attach);
  try{await row.getByRole('button',{name:'下载',exact:true}).click();const download=await downloadPromise;await download.saveAs(arg.target);if(await download.failure())throw Error('文件下载失败');return {filename:download.suggestedFilename()};}
  finally{clearTimeout(timer);ctx.off('page',attach);for(const p of ctx.pages())p.off('download',listener);}
 }
 throw Error('不支持的浏览器操作');
}

