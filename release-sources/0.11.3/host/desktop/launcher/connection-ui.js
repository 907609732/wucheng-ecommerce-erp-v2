/* Native settings UI. Confirmation IPC is deliberately absent from CLI/MCP. */
(()=>{
 const api=window.launcher,$=id=>document.getElementById(id),node=(tag,text)=>Object.assign(document.createElement(tag),{textContent:text||''}),names={warehouse:'云仓',purchase:'采购',sales:'销售',overview:'经营总览',exporter:'历史订单'};let batch;
 const error=e=>$('migrationMessage').textContent=e.message||String(e);
 const action=(id,fn)=>$(id).onclick=async()=>{const button=$(id);button.disabled=true;try{await fn();}catch(e){error(e);}finally{button.disabled=false;}};
 function render(result){
  batch=result;$('migrationBatchId').value=result.id;$('migrationMessage').textContent=result.error?.message||'';
  $('migrationTitle').textContent='旧账本迁移 · '+({staged:'隔离暂存',draft:'逐项核对','first-confirmed':'整批核对','second-confirmed':'等待正式提交',completed:'迁移完成','rolled-back':'已整批撤销','recovery-required':'需恢复后再开放写入',committing:'正在迁移'}[result.status]||result.status);
  $('migrationRows').replaceChildren();
  const first=['staged','draft','rolled-back'].includes(result.status);
  for(const [module,preview]of Object.entries(result.modules||{})){
   const group=node('section'),title=node('h3',(names[module]||module)+' · '+preview.rows.length+' 条');group.append(title);
   for(const row of preview.rows){
    const details=node('details'),summary=node('summary',row.kind+' / '+row.sourceId+' · '+({new:'新增',duplicate:'完全重复',conflict:'存在差异',blocked:'需先处理'}[row.action]||row.action));details.append(summary);
    const choose=node('select');choose.dataset.module=module;choose.dataset.kind=row.kind;choose.dataset.sourceId=row.sourceId;
    for(const [value,label]of row.action==='new'?[['skip','跳过'],['add','新增']]:row.action==='conflict'?[['skip','保留已有记录'],['update','逐字段更新']]:[['skip',row.action==='duplicate'?'跳过完全重复记录':'暂不迁移，先处理原因']]){const option=node('option',label);option.value=value;choose.append(option);}
    const old=result.selections?.[module]?.find(s=>s.kind===row.kind&&String(s.sourceId)===String(row.sourceId));choose.value=old?.action||(row.action==='new'?'add':'skip');choose.disabled=!first;details.append(choose);
    if(row.issues?.length)details.append(node('p',row.issues.map(i=>i.message||i).join('；')));
    const compare=node('div');compare.className='migrationCompare';
    for(const [label,data]of [['来源资料',row.incoming],['主服务器已有资料',row.proposed]]){const col=node('div');col.append(node('strong',label),node('pre',JSON.stringify(data,null,2)));compare.append(col);}details.append(compare);
    for(const d of row.differences||[]){const label=node('label',d.field+'：'),select=node('select');select.dataset.field=d.field;select.dataset.module=module;select.dataset.kind=row.kind;select.dataset.sourceId=row.sourceId;for(const [value,text]of [['existing','保留原值'],['incoming','使用来源值']]){const opt=node('option',text);opt.value=value;select.append(opt);}select.value=old?.fields?.[d.field]||'existing';select.disabled=!first||d.emptyIncoming;label.append(select);details.append(label);}
    group.append(details);
   }$('migrationRows').append(group);
  }
  $('migrationSummary').textContent=JSON.stringify({sourceDigest:result.sourceDigest,snapshotDigest:result.snapshotDigest,modules:Object.fromEntries(Object.entries(result.modules||{}).map(([id,p])=>[id,{counts:p.counts,summary:p.summary,revision:p.revision}])),results:result.results,error:result.error,recovery:result.recovery},null,2);
  $('migrationRows').hidden=!first;$('migrationSave').hidden=!first;$('migrationFirst').hidden=!first;$('migrationSecond').hidden=result.status!=='first-confirmed';$('migrationCommit').hidden=result.status!=='second-confirmed';$('migrationArchive').hidden=result.status!=='completed';$('migrationBack').hidden=!['first-confirmed','second-confirmed'].includes(result.status);$('migrationRecover').hidden=result.status!=='recovery-required';
 }
 function selections(){const result={};for(const select of $('migrationRows').querySelectorAll('select:not([data-field])')){const row={kind:select.dataset.kind,sourceId:select.dataset.sourceId,action:select.value,fields:{}};for(const field of $('migrationRows').querySelectorAll('select[data-field]'))if(field.dataset.module===select.dataset.module&&field.dataset.kind===row.kind&&field.dataset.sourceId===row.sourceId)row.fields[field.dataset.field]=field.value;(result[select.dataset.module]||=[]).push(row);}return result;}
 async function save(){if(!batch)throw Error('请先准备或读取迁移批次');render(await api.migrationSelect({id:batch.id,revision:batch.revision,selections:selections()}));}
 $('migrationOpen').onclick=async()=>{await api.hide();$('migrationDialog').showModal();};
 $('migrationClose').onclick=()=>{$('migrationDialog').close();};
 action('migrationStage',async()=>{const result=await api.migrationStage();$('migrationBatchId').value=result.id;render(await api.migrationGet(result.id));});
 action('migrationRead',async()=>render(await api.migrationGet($('migrationBatchId').value.trim())));
 action('migrationList',async()=>{const result=await api.migrationList();$('migrationBatches').replaceChildren(...result.batches.map(row=>{const b=node('button',row.id+' · '+row.status);b.onclick=()=>api.migrationGet(row.id).then(render).catch(error);return b;}));});
 action('migrationRelease',async()=>{if(!confirm('取消本机来源账本的封存准备？旧账本可以继续核对，客户端仍保持待迁移状态。'))return;await api.releaseSource();$('migrationMessage').textContent='已取消本机来源封存准备。修改旧账本后，请重新准备资料。';});
 action('migrationBack',async()=>render({...batch,status:'draft'}));
 action('migrationRecover',async()=>render(await api.migrationRecover(batch.id)));
 action('migrationSave',save);
 action('migrationFirst',async()=>{await save();render(await api.migrationConfirm({id:batch.id,revision:batch.revision,step:1}));});
 action('migrationSecond',async()=>render(await api.migrationConfirm({id:batch.id,revision:batch.revision,step:2,reviewDigest:batch.reviewDigest})));
 action('migrationCommit',async()=>render(await api.migrationCommit({id:batch.id,revision:batch.revision,reviewDigest:batch.reviewDigest})));
 action('migrationArchive',async()=>{await api.migrationArchive(batch.id);$('migrationMessage').textContent='已核对服务器回执，旧账本保留留档；客户端现在可以在线录入。';});
 function member(login='',value={role:'viewer',modules:[],canRunTasks:false,enabled:true}){
  const row=node('section');row.className='permissionRow';const name=node('input');name.placeholder='Tailscale 登录邮箱';name.value=login;name.dataset.login='';row.append(name);
  const role=node('select');role.dataset.role='';for(const key of ['admin','editor','viewer']){const option=node('option',{admin:'管理员',editor:'编辑成员',viewer:'只读成员'}[key]);option.value=key;role.append(option);}role.value=value.role;row.append(role);
  for(const id of ['warehouse','purchase','sales','overview','exporter']){const label=node('label',names[id]),check=node('input');check.type='checkbox';check.dataset.module=id;check.checked=value.modules.includes(id);label.prepend(check);row.append(label);}
  for(const [key,label]of [['canRunTasks','允许采集与发送'],['enabled','启用']]){const wrap=node('label',label),check=node('input');check.type='checkbox';check.dataset[key]='';check.checked=value[key];wrap.prepend(check);row.append(wrap);}$('permissionRows').append(row);
 }
 $('permissionsOpen').onclick=async()=>{try{const policy=await api.permissions();$('permissionRows').replaceChildren();Object.entries(policy.users).forEach(([key,value])=>member(key,value));$('permissionsDialog').showModal();}catch(e){$('message').textContent=e.message;}};
 $('permissionAdd').onclick=()=>member();$('permissionClose').onclick=()=>$('permissionsDialog').close();
 $('permissionSave').onclick=async()=>{try{const users={};for(const row of $('permissionRows').children){const login=row.querySelector('[data-login]').value.trim().toLowerCase();if(!login||users[login])throw Error('成员身份缺失或重复');users[login]={role:row.querySelector('[data-role]').value,modules:[...row.querySelectorAll('[data-module]:checked')].map(v=>v.dataset.module),canRunTasks:row.querySelector('[data-can-run-tasks]').checked,enabled:row.querySelector('[data-enabled]').checked};}await api.savePermissions({schemaVersion:1,users});$('permissionMessage').textContent='权限已保存，后续请求立即使用新权限。';}catch(e){$('permissionMessage').textContent=e.message;}};
})();
