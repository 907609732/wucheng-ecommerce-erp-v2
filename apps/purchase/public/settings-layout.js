// Keep existing controls and event delegation while grouping settings into compact rows.
export function organizeSettings(root){
 const grid=root.querySelector('.settings-grid');
 const panels=[...grid.children];
 const byTitle=new Map(panels.map(panel=>[panel.querySelector('h2')?.textContent||panel.querySelector('summary')?.textContent,panel]));
 const password=root.querySelector('.admin-settings');
 const shortcuts=root.querySelector(':scope > section:not(.admin-settings)');
 const heading=document.createElement('h2');heading.textContent='常用管理';
 const head=document.createElement('div');head.className='panel-head';head.append(heading);shortcuts.prepend(head);
 const logs=document.createElement('a');logs.className='btn';logs.href='#logs';logs.textContent='订单日志';shortcuts.querySelector('.actions').append(logs);
 shortcuts.classList.add('settings-shortcuts');
 const about=byTitle.get('关于'),intro=byTitle.get('软件介绍');
 if(about&&intro)about.querySelector('.panel-body').prepend(...intro.querySelector('.panel-body').children);
 function row(panel,title,hint){
  if(!panel)return null;
  let details=panel;
  if(panel.tagName!=='DETAILS'){
   details=document.createElement('details');
   const header=panel.querySelector(':scope > .panel-head');
   const description=header?.querySelector('p');
   if(description){description.classList.add('privacy-note');header.after(description);}
   header?.remove();details.append(...panel.children);
  }
  details.className=panel.className;details.classList.add('panel','settings-disclosure','settings-row');details.removeAttribute('style');details.open=false;
  let summary=details.querySelector(':scope > summary');
  if(!summary){summary=document.createElement('summary');details.prepend(summary);}
  summary.replaceChildren();const label=document.createElement('span');label.textContent=title;summary.append(label);
  if(hint){const note=document.createElement('small');note.textContent=hint;summary.append(note);}
  return details;
 }
 const fragment=document.createDocumentFragment();fragment.append(shortcuts);
 const groups=[
  ['偏好与维护',[
   [byTitle.get('字号大小'),'外观与显示','字号、显示偏好'],
   [byTitle.get('检查更新'),'版本与更新','查看版本、检查更新'],
  ]],
  ['数据与安全',[
   [byTitle.get('数据备份'),'数据备份','完整备份与恢复说明'],
   [byTitle.get('导出任务'),'导出数据','订单、分类明细、月度报表'],
   [password,'管理员密码','月度确认与取消确认保护'],
   [byTitle.get('执行日志 / 订单日志'),'订单日志与撤销','查看修改记录、撤销误操作'],
  ]],
  ['帮助与关于',[
   [byTitle.get('使用教程'),'快速入门','录入、核对、查询与管理'],
   [byTitle.get('各平台订单导入教程'),'平台导入教程','准备各平台订单文件'],
   [byTitle.get('识别与数据规则'),'本地识别','模型状态与识别说明'],
   [byTitle.get('统计口径'),'统计口径','有效采购、净支出与退款'],
   [byTitle.get('使用统计'),'使用统计','本机使用次数与活跃天数'],
   [about,'关于灵兔采购台','软件介绍、版本与官网'],
  ]],
 ];
 for(const [title,entries] of groups){
  const section=document.createElement('section');section.className='settings-group';
  const heading=document.createElement('h2');heading.textContent=title;section.append(heading);
  for(const [panel,label,hint] of entries){const item=row(panel,label,hint);if(item)section.append(item);}
  fragment.append(section);
 }
 root.replaceChildren(fragment);root.classList.add('settings-organized');
}
