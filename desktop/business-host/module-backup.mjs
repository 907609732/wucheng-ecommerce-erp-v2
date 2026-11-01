/** Use the existing lifecycle's database-checked backup implementation. This
 * entry is shared by the workbench; module-local settings pages are retired. */
export async function backupBusinessModule({id,services,lifecycle,prepare}={}){
  if(!['purchase','sales','overview'].includes(id))throw Error('不支持的账本备份类型');
  await prepare?.(id);
  const before=await services.capabilities(id);
  if(before?.busy)throw Object.assign(Error('该业务仍有任务正在执行，请完成后再备份'),{code:'SERVICE_BUSY'});
  try{
    await lifecycle.checkIdle(id);
    const backup=await lifecycle.backup(id);
    if(!backup?.hadData||!backup.directory)throw Error('没有可备份的现有账本');
    return {ok:true,id,directory:backup.directory,dataRetained:true};
  }finally{if(before?.running||before?.url)await services.ensure(id);}
}
