export const dailyOverviewMarkup = `
<section class="panel daily-sync-panel" aria-labelledby="dailySyncTitle">
  <div class="section-heading"><div><p class="eyebrow">TODAY'S SYNC</p><h2 id="dailySyncTitle">今日同步</h2></div><span id="dailySyncBadge" class="daily-badge">正在核对</span></div>
  <p id="dailyDate" class="daily-muted">按北京时间核对今日数据</p>
  <ol class="daily-stages" aria-label="今日同步进度">
    <li id="dailyCollectStage"><span class="daily-step">1</span><div><strong>拉取最新数据</strong><p id="dailyCollectText">等待核对</p></div></li>
    <li id="dailyValidateStage"><span class="daily-step">2</span><div><strong>校验并入库</strong><p id="dailyValidateText">等待核对</p></div></li>
    <li id="dailySendStage"><span class="daily-step">3</span><div><strong>同步到钉钉群</strong><p id="dailySendText">等待核对</p></div></li>
  </ol><p id="dailySyncDetail" class="daily-note" role="status">正在读取服务器记录…</p>
</section>
<div class="daily-work-grid">
  <section class="panel daily-personal"><div class="section-heading"><div><p class="eyebrow">MY WORK</p><h2>我的工作打卡</h2></div><span id="dailySelfBadge" class="daily-badge">身份核对中</span></div>
    <p id="dailySelfName" class="daily-person-name">正在读取身份…</p><p id="dailySelfTask" class="daily-muted"></p>
    <div class="daily-person-times"><span>今日签到<strong id="dailyCheckInTime">—</strong></span><span>任务完成<strong id="dailyCompleteTime">—</strong></span></div>
    <div class="actions"><button id="dailyCheckIn" class="primary" type="button" disabled>今日签到</button><button id="dailyComplete" type="button" disabled>确认今日任务完成</button></div>
    <p id="dailySelfHint" class="daily-muted">签到和任务完成分别记录，不能代替本人操作。</p>
  </section>
  <section class="panel daily-team"><div class="section-heading"><div><p class="eyebrow">TEAM PROGRESS</p><h2 id="dailyTeamTitle">团队今日进度</h2></div><button type="button" data-open-view="attendance" id="dailyManageLink">查看签到管理</button></div>
    <div class="daily-counts"><span>应完成<strong id="dailyExpected">—</strong></span><span>已签到<strong id="dailyCheckedIn">—</strong></span><span>已完成<strong id="dailyCompleted">—</strong></span><span>待完成<strong id="dailyPending">—</strong></span></div>
    <p id="dailyTeamHint" class="daily-muted">按员工工作日统计；签到后仍需核对库存并确认任务。</p>
  </section>
</div><p id="dailyMessage" class="daily-message" role="status" aria-live="polite"></p>`;

export const dailyManagementMarkup = `
<section class="panel"><div class="section-heading"><div><p class="eyebrow">DAILY WORK</p><h2>员工签到与任务</h2></div><div class="actions"><button type="button" id="dailyAddEmployee" class="daily-admin-only">添加员工</button><button type="button" id="dailyRefresh">刷新记录</button></div></div>
  <p id="dailyManagementMessage" class="daily-message" role="status" aria-live="polite"></p>
  <p class="daily-muted">每日签到和任务确认分别留痕。员工从工作台 Tailscale 入口本人登录，确认任务前需完成今日采集、校验与群同步。</p>
  <div class="daily-table-wrap"><table class="daily-table"><thead><tr><th>员工 / 今日任务</th><th>截止时间</th><th>签到</th><th>任务完成</th><th>状态</th><th>操作</th></tr></thead><tbody id="dailyEmployeeRows"><tr><td colspan="6">正在读取…</td></tr></tbody></table></div>
</section>
<section class="panel daily-admin-only" id="dailyEmployeeManager"><div class="section-heading"><div><p class="eyebrow">TEAM SETTINGS</p><h2>员工与工作安排</h2></div><span class="daily-badge">管理员</span></div>
  <p class="daily-muted">Tailscale 登录账号须与工作台成员一致；此处的员工名单不会自动授予工作台访问权限。</p>
  <form id="dailyEmployeeForm"><div class="form-grid daily-form-grid">
    <label>员工姓名<input id="dailyEmployeeName" required maxlength="80" autocomplete="off"></label>
    <label>Tailscale 登录账号<input id="dailyEmployeeLogin" required maxlength="254" placeholder="员工工作台登录邮箱" autocomplete="off"></label>
    <label>每日任务<input id="dailyEmployeeTask" required maxlength="300" value="核对库存并处理预警"></label>
    <label>每日截止时间（北京时间）<input id="dailyEmployeeDeadline" type="time" required value="18:00"></label>
    <label>接收提醒的邮箱<input id="dailyEmployeeEmail" type="email" maxlength="254" autocomplete="off"></label>
    <label>手机号<input id="dailyEmployeeMobile" type="tel" maxlength="30" autocomplete="off" placeholder="短信 / 电话提醒号码"></label>
    <label>钉钉用户 ID<input id="dailyEmployeeDingtalk" maxlength="150" autocomplete="off"></label>
    <label class="check"><input id="dailyEmployeeEnabled" type="checkbox" checked>启用此员工的每日任务</label>
  </div><fieldset class="daily-choice-field"><legend>工作日</legend><div class="daily-choice-row" id="dailyWorkdays">${[1,2,3,4,5,6,7].map((day,i)=>`<label class="check"><input type="checkbox" name="dailyWorkday" value="${day}" ${day<6?'checked':''}>${['周一','周二','周三','周四','周五','周六','周日'][i]}</label>`).join('')}</div></fieldset>
  <fieldset class="daily-choice-field"><legend>催办渠道</legend><div class="daily-choice-row">${[['email','邮件'],['dingtalk','钉钉'],['sms','短信'],['phone','电话']].map(([id,name])=>`<label class="check"><input type="checkbox" name="dailyEmployeeChannel" value="${id}">${name}</label>`).join('')}</div></fieldset>
  <div class="settings-actions"><p id="dailyEmployeeMessage" class="save-message" role="status"></p><button type="button" id="dailyEmployeeCancel" class="hidden">取消编辑</button><button class="primary" type="submit" id="dailyEmployeeSave">添加员工</button></div></form>
  <div class="daily-auto-setting"><label class="check"><input type="checkbox" id="dailyAutoRemind">截止后自动提醒未完成的员工</label><p class="daily-muted">默认关闭。开启后按员工选定的渠道提醒；短信和电话可能由服务商计费。服务须持续运行。</p><button id="dailySavePolicy" type="button">保存自动提醒设置</button></div>
</section>
<section class="panel daily-admin-only"><div class="section-heading"><div><p class="eyebrow">REMINDER CHANNELS</p><h2>提醒渠道</h2></div></div><div id="dailyChannelCards" class="daily-channel-grid"></div>
  <p class="daily-muted" id="dailyChannelHint">敏感凭据仅在主服务器本机配置。短信与电话需开通服务并配置已审核模板。每位员工每天每个渠道最多发起一次提醒；失败或结果未知时须先核对服务商记录。</p>
  <details id="dailyReminderSettings"><summary>配置邮件、短信与电话服务</summary><form id="dailyReminderForm"><div class="form-grid daily-form-grid">
    <label>SMTP 主机<input id="dailySmtpHost" autocomplete="off" placeholder="smtp.example.com"></label><label>SMTP 端口<input id="dailySmtpPort" type="number" min="1" max="65535" value="465"></label>
    <label>SMTP 用户<input id="dailySmtpUser" autocomplete="off"></label><label>发件邮箱<input id="dailySmtpFrom" type="email" autocomplete="off"></label>
    <label>SMTP 密码 / 授权码<input id="dailySmtpPassword" type="password" autocomplete="new-password" placeholder="留空保留已保存凭据"></label><label class="check"><input id="dailySmtpSecure" type="checkbox" checked>使用 SMTP TLS（通常为 465 端口）</label>
    <label>阿里云 AccessKey ID<input id="dailyAliyunAccessKeyId" type="password" autocomplete="new-password" placeholder="留空保留已保存凭据"></label><label>阿里云 AccessKey Secret<input id="dailyAliyunAccessKeySecret" type="password" autocomplete="new-password" placeholder="留空保留已保存凭据"></label>
    <label>短信签名<input id="dailySmsSignName" autocomplete="off"></label><label>短信模板编号<input id="dailySmsTemplateCode" autocomplete="off"></label>
    <label>短信模板参数 JSON<input id="dailySmsTemplateParams" autocomplete="off" placeholder='{"name":"{name}","date":"{date}"}'></label><label>语音模板编号<input id="dailyPhoneTemplateCode" autocomplete="off"></label>
    <label>语音模板参数 JSON<input id="dailyPhoneTemplateParams" autocomplete="off" placeholder='{"name":"{name}","date":"{date}"}'></label><label>语音主叫号码（服务要求时填写）<input id="dailyPhoneCalledShowNumber" autocomplete="off"></label>
  </div><p class="daily-muted">参数可使用 {name}、{date}、{task}。服务商接单不代表员工已收到或已接听。</p><div class="settings-actions"><p id="dailyReminderSettingsMessage" class="save-message" role="status"></p><button class="primary" type="submit" id="dailyReminderSave">保存提醒服务设置</button></div></form></details>
</section>
<section class="panel daily-admin-only"><div class="section-heading"><div><p class="eyebrow">REMINDER HISTORY</p><h2>提醒记录</h2></div></div><div class="daily-table-wrap"><table class="daily-table"><thead><tr><th>时间</th><th>员工</th><th>渠道</th><th>结果</th><th>详情</th></tr></thead><tbody id="dailyReminderRows"><tr><td colspan="5">暂无提醒记录</td></tr></tbody></table></div></section>
<dialog id="dailyRemindDialog" class="daily-dialog" aria-labelledby="dailyRemindTitle"><form method="dialog"><div class="section-heading"><h2 id="dailyRemindTitle">提醒员工完成今日任务</h2><button value="cancel" aria-label="关闭提醒窗口">关闭</button></div><p id="dailyRemindTarget"></p><p id="dailyRemindTask" class="daily-muted"></p><fieldset class="daily-choice-field"><legend>本次提醒方式</legend><div id="dailyRemindChoices" class="daily-choice-row"></div></fieldset><p class="daily-muted">仅提醒当前选中的员工。短信与电话可能计费；服务商受理不代表员工已收到或接听。每天每人每渠道最多一次；已有记录将返回原结果，不重复发送。</p><p id="dailyRemindMessage" role="alert" class="daily-message"></p><div class="settings-actions"><button value="cancel">取消</button><button type="button" id="dailyRemindConfirm" class="primary">确认发送提醒</button></div></form></dialog>`;

export const dailyStyles = `
.daily-sync-panel .section-heading{margin-bottom:12px}.daily-muted{color:var(--muted,#746f66);font-size:13px;line-height:1.7;margin:10px 0}.daily-note{margin:16px 0 0;padding:12px 14px;border-radius:10px;background:#f5f1eb;color:#746f66;font-size:13px;line-height:1.7;overflow-wrap:anywhere}.daily-badge{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border:1px solid #ded8ce;border-radius:99px;color:#746f66;background:#f8f5f0;font-size:12px;white-space:nowrap}.daily-badge.good{background:#eff8f1;color:#2c7a58;border-color:#b7d4c1}.daily-badge.warn{background:#fff4e7;color:#995916;border-color:#e9c69a}.daily-badge.bad{background:#fff0ec;color:#9f3d24;border-color:#e4b5a8}.daily-stages{padding:0;list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0 0}.daily-stages li{display:flex;gap:11px;padding:16px;border:1px solid #e4ded5;border-radius:13px;min-width:0;background:#fffdfa}.daily-stages strong{font-size:14px}.daily-stages p{font-size:12px;color:#746f66;margin:7px 0 0;line-height:1.6;overflow-wrap:anywhere}.daily-step{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:50%;background:#eee8df;color:#746f66;font-size:12px;font-weight:700}.daily-stages .done{border-color:#b7d4c1;background:#f7fbf7}.daily-stages .done .daily-step{color:#fff;background:#2c7a58}.daily-stages .failed{border-color:#e4b5a8;background:#fff7f4}.daily-stages .failed .daily-step{color:#fff;background:#b64d32}.daily-work-grid{display:grid;grid-template-columns:1.08fr 1fr;gap:14px}.daily-work-grid .panel{min-width:0}.daily-person-name{font-size:18px;font-weight:700;margin:0}.daily-person-times{display:flex;gap:40px;margin:18px 0}.daily-person-times span,.daily-counts>span{color:#746f66;font-size:12px}.daily-person-times strong{display:block;color:#211f1b;font-size:15px;margin-top:7px}.daily-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:24px 0}.daily-counts strong{display:block;font-size:32px;line-height:1.3;color:#211f1b;font-weight:700;margin-top:8px}.daily-counts>span:last-child strong{color:#9f3d24}.daily-message{color:#9f3d24;font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.daily-message:empty{display:none}.daily-table-wrap{overflow:auto}.daily-table{width:100%;border-collapse:collapse;font-size:13px}.daily-table th,.daily-table td{text-align:left;padding:13px 11px;border-bottom:1px solid #e8e1d8;vertical-align:middle}.daily-table th{font-size:12px;color:#746f66;background:#f7f3ed;white-space:nowrap}.daily-table td{line-height:1.6}.daily-table small{display:block;color:#746f66;font-size:12px}.daily-table button{padding:8px 11px;font-size:12px;white-space:nowrap;margin:2px}.daily-table .daily-name{font-weight:700}.daily-table .daily-empty{padding:30px;text-align:center;color:#746f66}.daily-choice-field{margin-top:16px;padding:16px;border:1px solid #ded8ce;border-radius:12px}.daily-choice-row{display:flex;flex-wrap:wrap;gap:14px}.daily-choice-row .check{margin:0;white-space:nowrap}.daily-auto-setting{border-top:1px solid #ded8ce;padding-top:22px;margin-top:24px}.daily-channel-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.daily-channel-card{padding:16px;border:1px solid #ded8ce;border-radius:12px}.daily-channel-card>strong{display:block;margin-bottom:12px}.daily-channel-card p{font-size:12px;line-height:1.6;color:#746f66;margin:10px 0 0}.daily-dialog{width:min(560px,calc(100% - 28px));padding:24px;border:1px solid #ded8ce;border-radius:18px;color:#211f1b;background:#fffdfa;max-height:90vh;overflow:auto}.daily-dialog::backdrop{background:#211f1b88}.daily-dialog .section-heading h2{font-size:21px}.daily-dialog .settings-actions{flex-wrap:wrap}#dailyReminderSettings{margin-top:18px;border-top:1px solid #ded8ce;padding-top:18px}#dailyReminderSettings summary{cursor:pointer;font-weight:700;font-size:14px;color:#9f3d24}#dailyReminderForm{margin-top:20px}.daily-form-grid input{min-width:0}.daily-table td:first-child{min-width:170px}.daily-inline-actions{display:flex;flex-wrap:wrap;gap:4px}.daily-team .section-heading button{font-size:12px;padding:9px 12px}.daily-error-note{color:#9f3d24}.daily-connection-card{margin-bottom:20px;padding:18px 20px;border:1px solid #ded8ce;border-radius:14px;background:#f7f3ed}.daily-connection-card h3{margin:0 0 7px;font-size:16px}.daily-connection-card p{margin:0;color:#746f66;font-size:13px;line-height:1.8}.daily-connection-card button{margin-top:12px}
@media(max-width:1000px){.daily-work-grid{grid-template-columns:1fr}.daily-channel-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:680px){.daily-stages{grid-template-columns:1fr}.daily-stages li{padding:12px}.daily-counts{gap:8px}.daily-counts strong{font-size:26px}.daily-channel-grid{grid-template-columns:1fr 1fr}.daily-person-times{gap:26px}.view-tabs{display:flex;flex-wrap:wrap}.daily-dialog{padding:18px}.daily-table th,.daily-table td{padding:11px 8px}.daily-form-grid{grid-template-columns:1fr}}
`;

export function installDailyUI(adapter) {
  const $ = id => document.getElementById(id);
  const labels = {email:'邮件',dingtalk:'钉钉',sms:'短信',phone:'电话'};
  const statuses = {pending:'待完成',overdue:'已逾期',completed:'已完成',off:'今日无需完成'};
  let current = null, busy = false, refreshing = false, editingLogin = '', reminderLogin = '';
  let hydratedSettings = false, configDirty = false, employeeRenderKey='';
  const text = (id, value) => { if ($(id)) $(id).textContent = String(value ?? ''); };
  const notify = value => { text('dailyMessage',value);text('dailyManagementMessage',value); };
  const make = (tag, value, className) => { const el = document.createElement(tag); if(value!==undefined)el.textContent=String(value);if(className)el.className=className;return el; };
  const time = value => { if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'时间待核对':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d); };
  const badge = (el, value, tone='') => {el.textContent=value;el.className='daily-badge '+tone;};
  const selected = name => [...document.querySelectorAll('input[name="'+name+'"]:checked')].map(input=>input.value);
  const error = e => notify('读取或提交失败：'+(e?.message||e));
  function permissions() {
    const admin=current?.actor?.role==='admin', local=current?.actor?.local===true;
    document.querySelectorAll('.daily-admin-only').forEach(el=>el.classList.toggle('hidden',!admin));
    if($('dailyReminderSettings'))$('dailyReminderSettings').classList.toggle('hidden',!admin||!local||!adapter.saveReminderSettings);
    for(const id of ['dailyCheckIn','dailyComplete','dailyEmployeeSave','dailySavePolicy','dailyReminderSave','dailyRemindConfirm'])if($(id))$(id).disabled=busy||!current;
    const me=current?.me, sync=current?.sync;
    if($('dailyCheckIn'))$('dailyCheckIn').disabled=busy||!me||local||current?.actor?.role==='viewer'||!!me.checkInAt||me.status==='off';
    if($('dailyComplete'))$('dailyComplete').disabled=busy||!me||local||current?.actor?.role==='viewer'||!me.checkInAt||me.status==='off'||!!me.completedAt||!sync?.complete;
  }
  function renderSync(data) {
    const s=data.sync||{}, expected=data.expectedSourceDate||data.businessDate, good=s.complete===true;
    text('dailyDate',(data.businessDate||'日期待核对')+' · 北京时间 · 最新结算日期 '+(expected||'—'));
    const unknown=s.deliveryStatus==='unknown',failed=!!s.error||['failed','invalid'].includes(s.deliveryStatus)||['failed','invalid'].includes(s.validationStatus)||s.collectionStatus==='failed';
    badge($('dailySyncBadge'),good?'今日已完成':unknown?'发送结果待核对':failed?'需要处理':s.startedAt?'今日尚未完成':'今日未同步',good?'good':unknown?'warn':failed?'bad':'warn');
    const stages=[['dailyCollectStage','dailyCollectText',s.collectedAt,s.collectionStatus,'来源日期 '+(s.sourceDate||'—')],['dailyValidateStage','dailyValidateText',s.importedAt,s.validationStatus,'来源文件已校验并核对库存'],['dailySendStage','dailySendText',s.sentAt,s.deliveryStatus,'服务端已受理群消息']];
    for(const [id,copy,at,status,detail] of stages){const done=!!at&&['success','accepted'].includes(status);$(id).classList.toggle('done',done);$(id).classList.toggle('failed',['failed','invalid'].includes(status));text(copy,done?time(at)+' · '+detail:status==='skipped'?'本次未发送':status==='unknown'?'结果未知，请核对':status==='failed'||status==='invalid'?'未完成，请查看异常原因':id==='dailyValidateStage'&&s.validatedAt?'校验通过，等待入库':'等待完成');}
    let detail=good?'今天的最新数据已采集、校验入库，并已同步到钉钉群。':s.error||'只有今日最新数据完成全部三个步骤，才会标记为今日完成。';
    if(s.sourceDate&&s.sourceDate<expected)detail+=' 当前来源日期 '+s.sourceDate+'，需要 '+expected+' 或更新的数据。';
    if(s.lastAttempt?.error)detail+=' 最近一次尝试：'+s.lastAttempt.error;
    text('dailySyncDetail',detail);
  }
  function renderSelf(data) {
    const me=data.me, local=data.actor?.local===true;
    text('dailySelfName',local?'主服务器管理员':me?.name||data.actor?.name||data.actor?.login||'尚未识别员工身份');
    text('dailySelfTask',me?.task||'核对库存并处理预警');
    text('dailyCheckInTime',time(me?.checkInAt));text('dailyCompleteTime',time(me?.completedAt));
    badge($('dailySelfBadge'),local?'管理端':me?.completedAt?'任务已完成':me?.checkInAt?'已签到 · 待完成':me?'待签到':'未加入员工名单',me?.completedAt?'good':'');
    text('dailySelfHint',local?'请员工从工作台 Tailscale 入口本人登录打卡；管理端不能替员工签到。':!me?'请管理员将你的 Tailscale 登录账号加入员工名单。':me.status==='off'?'今天不在你的工作安排内。':me.completedAt?'已保存本人确认时间和关联的同步记录。':!me.checkInAt?'先签到，再核对今日库存、预警与群同步结果。':!data.sync?.complete?'你已签到。今日同步尚未完成，完成后即可确认任务。':'核对库存并完成预警处理后，点击“确认今日任务完成”。');
    for(const [key,id]of [['expected','dailyExpected'],['checkedIn','dailyCheckedIn'],['completed','dailyCompleted'],['pending','dailyPending']])text(id,data.team?.[key]??0);
    text('dailyTeamTitle',data.actor?.role==='admin'?'团队今日进度':'我的今日进度');text('dailyManageLink',data.actor?.role==='admin'?'查看签到管理':'查看我的记录');
    text('dailyTeamHint',data.team?.expected?'今日 '+data.team.expected+' 人需要完成任务，'+(data.team.pending||0)+' 人待完成。':'尚无今日工作安排。管理员可在签到管理中添加员工及工作日。');
  }
  function renderEmployees(data) {
    const rows=$('dailyEmployeeRows');if(!rows)return;
    const list=data.employees||[],admin=data.actor?.role==='admin';
    const nextKey=JSON.stringify([list,admin,busy]);if(nextKey===employeeRenderKey)return;employeeRenderKey=nextKey;
    rows.replaceChildren();
    if(!list.length){const tr=make('tr'),td=make('td','还没有员工记录。请管理员先配置员工、工作日与截止时间。','daily-empty');td.colSpan=6;tr.append(td);rows.append(tr);return;}
    for(const e of list){const tr=make('tr');const name=make('td');name.append(make('span',e.name||e.login,'daily-name'),make('small',e.task||''));tr.append(name,make('td',(e.deadline||'18:00')+' 北京时间'),make('td',time(e.checkInAt)),make('td',time(e.completedAt)));
      const status=make('td'),pill=make('span');badge(pill,(statuses[e.status]||'待完成')+(e.late?' · 迟完成':''),e.status==='completed'?'good':e.status==='overdue'?'bad':'');status.append(pill);tr.append(status);
      const actions=make('td'),wrap=make('div',undefined,'daily-inline-actions');if(admin){const edit=make('button','编辑');edit.type='button';edit.disabled=busy;edit.onclick=()=>editEmployee(e.login);wrap.append(edit);const remind=make('button','提醒');remind.type='button';remind.disabled=busy||e.status==='completed'||e.status==='off';remind.onclick=()=>openReminder(e.login);wrap.append(remind);}else wrap.append(make('span','由本人确认'));actions.append(wrap);tr.append(actions);rows.append(tr);
    }
  }
  function renderChannels(data) {
    const el=$('dailyChannelCards');if(!el)return;el.replaceChildren();
    for(const [id,label]of Object.entries(labels)){const c=data.channels?.[id]||{},card=make('article',undefined,'daily-channel-card');card.append(make('strong',label));const state=make('span');badge(state,c.ready?'可使用':'待配置',c.ready?'good':'');card.append(state,make('p',c.reason||(c.ready?'服务配置已保存，实际发送结果见提醒记录。':'尚未完成服务配置。')));el.append(card);}
    if(!configDirty&&$('dailyAutoRemind'))$('dailyAutoRemind').checked=data.config?.autoRemind===true;
    if(!hydratedSettings&&data.reminderSettings){const s=data.reminderSettings;for(const [key,id]of Object.entries({smtpHost:'dailySmtpHost',smtpPort:'dailySmtpPort',smtpUser:'dailySmtpUser',smtpFrom:'dailySmtpFrom',smsSignName:'dailySmsSignName',smsTemplateCode:'dailySmsTemplateCode',smsTemplateParams:'dailySmsTemplateParams',phoneTemplateCode:'dailyPhoneTemplateCode',phoneTemplateParams:'dailyPhoneTemplateParams',phoneCalledShowNumber:'dailyPhoneCalledShowNumber'}))if($(id))$(id).value=s[key]??'';if($('dailySmtpSecure'))$('dailySmtpSecure').checked=s.smtpSecure!==false;for(const [key,id]of Object.entries({smtpPassword:'dailySmtpPassword',aliyunAccessKeyId:'dailyAliyunAccessKeyId',aliyunAccessKeySecret:'dailyAliyunAccessKeySecret'}))if($(id))$(id).placeholder=s.secretFlags?.[key]?'已加密保存；留空保留':'尚未配置；留空保留';hydratedSettings=true;}
    const tbody=$('dailyReminderRows');if(!tbody)return;tbody.replaceChildren();
    const list=data.reminders||[];if(!list.length){const tr=make('tr'),td=make('td','暂无提醒记录','daily-empty');td.colSpan=5;tr.append(td);tbody.append(tr);}
    for(const r of list){const tr=make('tr');tr.append(make('td',time(r.createdAt)),make('td',r.name||r.login),make('td',labels[r.channel]||r.channel),make('td',({accepted:'服务商已受理',failed:'发送失败',unknown:'结果待核对',unconfigured:'未配置'})[r.status]||r.status||'—'),make('td',r.message||r.receiptId||'—'));tbody.append(tr);}
  }
  function render(data){current=data;renderSync(data);renderSelf(data);renderEmployees(data);renderChannels(data);permissions();}
  async function refresh(){if(refreshing||busy)return;refreshing=true;try{const data=await adapter.read();if(!data||!data.actor||!data.sync)throw Error('服务接口尚未就绪，请更新主服务器云仓模块');render(data);notify('');}catch(e){current=null;badge($('dailySyncBadge'),'无法核对','bad');text('dailySyncDetail','无法读取主服务器的今日同步凭据，请检查连接后重试。');error(e);permissions();}finally{refreshing=false;}}
  async function action(fn,message){if(busy||!current)return;busy=true;permissions();try{const result=await fn();notify(message||'已保存');if(result?.results&&result.results.some(r=>r.status!=='accepted'))notify('部分提醒未被服务商受理，请查看提醒记录。');busy=false;await refresh();if(message)notify(message);return result;}catch(e){error(e);throw e;}finally{busy=false;permissions();}}
  function resetEmployee(){editingLogin='';$('dailyEmployeeForm')?.reset();$('dailyEmployeeLogin').disabled=false;text('dailyEmployeeSave','添加员工');$('dailyEmployeeCancel').classList.add('hidden');text('dailyEmployeeMessage','');}
  function editEmployee(login){const e=(current?.config?.employees||current?.employees||[]).find(e=>e.login===login);if(!e)return;editingLogin=login;for(const[key,id]of Object.entries({name:'dailyEmployeeName',login:'dailyEmployeeLogin',task:'dailyEmployeeTask',deadline:'dailyEmployeeDeadline',email:'dailyEmployeeEmail',mobile:'dailyEmployeeMobile',dingtalkUserId:'dailyEmployeeDingtalk'}))$(id).value=e[key]||'';$('dailyEmployeeEnabled').checked=e.enabled!==false;$('dailyEmployeeLogin').disabled=true;document.querySelectorAll('input[name="dailyWorkday"]').forEach(i=>i.checked=(e.workdays||[1,2,3,4,5]).includes(Number(i.value)));document.querySelectorAll('input[name="dailyEmployeeChannel"]').forEach(i=>i.checked=(e.channels||[]).includes(i.value));text('dailyEmployeeSave','保存员工安排');$('dailyEmployeeCancel').classList.remove('hidden');$('dailyEmployeeManager')?.scrollIntoView({behavior:'smooth',block:'start'});$('dailyEmployeeName').focus();}
  function openReminder(login){const e=(current?.employees||[]).find(e=>e.login===login);if(!e)return;reminderLogin=login;text('dailyRemindTarget',(e.name||e.login)+' · '+e.login);text('dailyRemindTask',(e.task||'今日任务')+'；截止 '+(e.deadline||'18:00')+'（北京时间）');text('dailyRemindMessage','');const choices=$('dailyRemindChoices');choices.replaceChildren();for(const[id,label]of Object.entries(labels)){const c=current.channels?.[id]||{},enabled=(e.channels||[]).includes(id),target=id==='email'?e.email:id==='dingtalk'?e.dingtalkUserId:e.mobile,ready=c.ready&&enabled&&!!target,l=make('label',undefined,'check'),input=make('input');input.type='checkbox';input.name='dailyRemindChannel';input.value=id;input.disabled=!ready;input.checked=ready;l.append(input,document.createTextNode(label+(!c.ready?'（服务待配置）':!enabled?'（员工未启用）':!target?'（缺少接收方式）':'')));choices.append(l);}$('dailyRemindDialog').showModal();}
  $('dailyCheckIn')?.addEventListener('click',()=>action(()=>adapter.action({action:'check-in'}),'今日签到已记录。').catch(()=>{}));
  $('dailyComplete')?.addEventListener('click',()=>{if(!current?.sync?.complete||!window.confirm('确认你已核对今日库存、完成预警处理，并检查钉钉群同步结果？系统将保存你的确认时间。'))return;action(()=>adapter.action({action:'complete',confirmed:true,runId:current.sync.runId}),'今日任务完成已记录。').catch(()=>{});});
  $('dailyRefresh')?.addEventListener('click',refresh);
  $('dailyEmployeeCancel')?.addEventListener('click',resetEmployee);
  $('dailyAddEmployee')?.addEventListener('click',()=>{resetEmployee();$('dailyEmployeeManager').scrollIntoView({behavior:'smooth',block:'start'});$('dailyEmployeeName').focus();});
  $('dailyAutoRemind')?.addEventListener('change',()=>{configDirty=true;});
  $('dailySavePolicy')?.addEventListener('click',()=>{const enabled=$('dailyAutoRemind').checked;if(enabled&&!window.confirm('启用后，主服务器将在员工截止时间后按所选渠道自动提醒；短信和电话可能计费。确认启用？'))return;action(()=>adapter.saveConfig({employees:current.config?.employees||[],autoRemind:enabled}),'自动提醒设置已保存。').then(()=>{configDirty=false;}).catch(()=>{});});
  $('dailyEmployeeForm')?.addEventListener('submit',event=>{event.preventDefault();const employee={login:$('dailyEmployeeLogin').value.trim().toLowerCase(),name:$('dailyEmployeeName').value.trim(),task:$('dailyEmployeeTask').value.trim(),email:$('dailyEmployeeEmail').value.trim(),mobile:$('dailyEmployeeMobile').value.trim(),dingtalkUserId:$('dailyEmployeeDingtalk').value.trim(),enabled:$('dailyEmployeeEnabled').checked,deadline:$('dailyEmployeeDeadline').value,workdays:selected('dailyWorkday').map(Number),channels:selected('dailyEmployeeChannel')};const employees=[...(current.config?.employees||[])];const index=employees.findIndex(e=>e.login===(editingLogin||employee.login));if(!editingLogin&&index>=0){text('dailyEmployeeMessage','此登录账号已经存在，请从上方列表编辑。');return;}if(index>=0)employees[index]=employee;else employees.push(employee);action(()=>adapter.saveConfig({employees,autoRemind:current.config?.autoRemind===true}),'员工安排已保存。').then(resetEmployee).catch(e=>text('dailyEmployeeMessage',e.message));});
  $('dailyRemindConfirm')?.addEventListener('click',async()=>{const channels=selected('dailyRemindChannel');if(!channels.length){text('dailyRemindMessage','至少选择一个可使用的提醒渠道。');return;}try{await action(()=>adapter.remind({logins:[reminderLogin],channels,confirmed:true}));$('dailyRemindDialog').close();notify('提醒请求已处理，请核对提醒记录中的逐渠道结果。');}catch(e){text('dailyRemindMessage',e.message);}});
  $('dailyReminderForm')?.addEventListener('submit',event=>{event.preventDefault();if(!adapter.saveReminderSettings)return;const settings={};for(const[key,id]of Object.entries({smtpHost:'dailySmtpHost',smtpPort:'dailySmtpPort',smtpUser:'dailySmtpUser',smtpFrom:'dailySmtpFrom',smsSignName:'dailySmsSignName',smsTemplateCode:'dailySmsTemplateCode',smsTemplateParams:'dailySmsTemplateParams',phoneTemplateCode:'dailyPhoneTemplateCode',phoneTemplateParams:'dailyPhoneTemplateParams',phoneCalledShowNumber:'dailyPhoneCalledShowNumber'}))settings[key]=key==='smtpPort'?Number($(id).value):$(id).value.trim();settings.smtpSecure=$('dailySmtpSecure').checked;const secrets={};for(const[key,id]of Object.entries({smtpPassword:'dailySmtpPassword',aliyunAccessKeyId:'dailyAliyunAccessKeyId',aliyunAccessKeySecret:'dailyAliyunAccessKeySecret'}))if($(id).value)secrets[key]=$(id).value;action(()=>adapter.saveReminderSettings({settings,secrets}),'提醒服务设置已加密保存。').then(()=>{for(const id of ['dailySmtpPassword','dailyAliyunAccessKeyId','dailyAliyunAccessKeySecret'])$(id).value='';hydratedSettings=false;refresh();}).catch(e=>text('dailyReminderSettingsMessage',e.message));});
  window.addEventListener('blur',()=>{for(const id of ['dailySmtpPassword','dailyAliyunAccessKeyId','dailyAliyunAccessKeySecret'])if($(id))$(id).type='password';});
  adapter.onState?.(()=>refresh());
  permissions();refresh();setInterval(refresh,15000);
  return {refresh};
}
