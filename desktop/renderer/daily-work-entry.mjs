import {dailyOverviewMarkup,dailyManagementMarkup,installDailyUI} from './daily-work-ui.mjs';
document.getElementById('dailyOverview').innerHTML=dailyOverviewMarkup;
document.getElementById('dailyManagement').innerHTML=dailyManagementMarkup;
document.getElementById('dailyManageLink').addEventListener('click',()=>document.querySelector('[data-view="attendance"]').click());
const api=window.inventoryApp;
installDailyUI({
  read:()=>api.getDailyStatus(),
  action:payload=>api.dailyAction(payload),
  remind:payload=>api.dailyAction({action:'remind',...payload}),
  saveConfig:payload=>api.saveDailyConfig(payload),
  saveReminderSettings:payload=>api.saveReminderSettings(payload),
  onState:listener=>api.onState(listener)
});
