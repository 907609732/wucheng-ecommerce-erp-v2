import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldRefreshPersonnel} from '../apps/sales/public/api-errors.js';
test('incorrect monthly passwords and business lock errors preserve the dialog',()=>{
 for(const code of ['MONTH_ADMIN_PASSWORD_INVALID','ADMIN_PASSWORD_INVALID','MONTH_NOT_ENDED','MONTH_ADMIN_UNCONFIGURED'])assert.equal(shouldRefreshPersonnel(403,{code},'/api/reconciliation/unlock'),false,code);
 assert.equal(shouldRefreshPersonnel(403,{code:'UNKNOWN_BUSINESS_ERROR'},'/api/reconciliation/lock'),false);
});
test('actual identity and permission failures refresh personnel, without recursive bootstrap',()=>{
 for(const code of ['PERSONNEL_REQUIRED','PERSONNEL_READ_ONLY','PERSONNEL_ROLE_DENIED','BOSS_REQUIRED'])assert.equal(shouldRefreshPersonnel(403,{code},'/api/reconciliation/preview'),true,code);
 assert.equal(shouldRefreshPersonnel(403,{error:'页面已过期，请刷新后重试'},'/api/close/unlock'),true);
 assert.equal(shouldRefreshPersonnel(403,{code:'PERSONNEL_REQUIRED'},'/api/bootstrap'),false);
 assert.equal(shouldRefreshPersonnel(400,{code:'BOSS_REQUIRED'},'/api/close/lock'),false);
});
