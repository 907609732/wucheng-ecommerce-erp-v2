import {fail,required} from './util.mjs';

export function deleteEmptyShop(s,shopId,input={}) {
  return s.transaction(()=>{
    const shop=s.get('SELECT * FROM shops WHERE id=?',shopId);
    if(!shop||shop.platform==='待归属')throw fail('店铺不存在或不能删除',404,'SHOP_NOT_FOUND');
    if(input.confirm!==true||required(input.name,'确认店铺名称',80)!==shop.name)throw fail('请核对店铺名称后确认删除',409,'SHOP_CONFIRMATION_REQUIRED');
    const references={};
    for(const {name} of s.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")){
      const quoted='"'+name.replaceAll('"','""')+'"';
      if(s.all('PRAGMA table_info('+quoted+')').some(column=>column.name==='shop_id')){
        const count=s.get('SELECT COUNT(*) n FROM '+quoted+' WHERE shop_id=?',shopId).n;
        if(count)references[name]=count;
      }
    }
    const quotedId=JSON.stringify(shopId);
    const stagedReference=s.get('SELECT 1 FROM imports WHERE instr(context_json,?)>0 OR instr(preview_json,?)>0 LIMIT 1',quotedId,quotedId);
    if(Object.keys(references).length||stagedReference||s.get('SELECT 1 FROM month_locks WHERE instr(snapshot,?)>0 LIMIT 1',quotedId))throw fail('这家店铺已有业务记录或锁定月历史，不能删除；原账单和历史数据已保留',409,'SHOP_HAS_RECORDS');
    const deleted=new Set(s.setting('deletedShopIds',[]));deleted.add(shopId);s.setSetting('deletedShopIds',[...deleted]);
    s.run('DELETE FROM shops WHERE id=?',shopId);
    s.audit('shop.delete',shopId,{shop,reason:'删除无业务记录的店铺'});
    return {ok:true,deleted:{id:shop.id,name:shop.name,platform:shop.platform}};
  });
}
