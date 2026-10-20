import {ServiceManager} from './service-manager.mjs';
const manager=new ServiceManager();
export const actions={
  status:()=>manager.status(),
  start:({desk})=>manager.ensure(desk),
  stop:({desk})=>manager.stop(desk),
  async query({desk,kind='orders',id='',query={}}){
    const paths={purchase:{orders:'/orders',transfers:'/transfers',transfer:'/transfers/'+encodeURIComponent(id),verification:'/transfers/'+encodeURIComponent(id)+'/verification',edits:'/edits',edit:'/edits/'+encodeURIComponent(id)},sales:{report:'/report',ledger:'/ledger',edits:'/edits',edit:'/edits/'+encodeURIComponent(id)},overview:{overview:'/overview',dashboard:'/dashboard',bills:'/bills',edits:'/edits',edit:'/edits/'+encodeURIComponent(id)},exporter:{tasks:'/tasks',orders:'/tasks/'+encodeURIComponent(id)+'/orders'}};
    const route=paths[desk]?.[kind];if(!route)throw Error('不支持的只读查询');
    const search=new URLSearchParams(query).toString();return manager.request(desk,route+(search?'?'+search:''));
  },
  async prepare({desk='purchase',kind='transfer',id,source,decisions,revision,edit}){
    if(kind==='edit')return manager.request(desk,'/edits',{method:'POST',body:edit});
    if(desk!=='purchase'||kind!=='transfer')throw Error('导入草稿只能交给采购台');
    return id?manager.request(desk,'/transfers/'+encodeURIComponent(id),{method:'PUT',body:{decisions,revision}}):manager.request(desk,'/transfers',{method:'POST',body:source});
  }
};
