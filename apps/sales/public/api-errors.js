/** Business validation failures must leave the current dialog and entered scope intact. */
export function shouldRefreshPersonnel(status,error={},url=''){
 if(status!==403||url.startsWith('/api/bootstrap')||url.startsWith('/api/personnel/session'))return false;
 return ['PERSONNEL_REQUIRED','PERSONNEL_READ_ONLY','PERSONNEL_ROLE_DENIED','BOSS_REQUIRED','SESSION_EXPIRED','AUTH_REQUIRED','FORBIDDEN'].includes(error.code)||(!error.code&&error.error==='页面已过期，请刷新后重试');
}
