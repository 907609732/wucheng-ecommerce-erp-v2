import {ServiceManager} from './service-manager.mjs';
export const EXPORTER_SHOW_API_VERSION=1;
export const createActions=(manager)=>({
  status:()=>manager.status(),
  async start({desk,show=false}){
    if(typeof show!=='boolean'||show&&desk!=='exporter')throw Error('仅历史订单导出台支持显示独立窗口');
    const result=await manager.ensure(desk);
    return show?manager.request(desk,'/open',{method:'POST',body:{confirm:true}}):result;
  },
  stop:({desk})=>manager.stop(desk),
  async query({desk,kind='orders',id='',query={},path}){
    if(path){if(!path.startsWith('/api/')||path.includes('..')||/[\\#\r\n]/.test(path)||!manager.business)throw Error('此完整业务查询需要工作台服务器连接');return manager.business(desk,path+(path.includes('?')?'&':'?')+new URLSearchParams(query));}
    const paths={warehouse:{state:'/workbench/state',inventory:'/workbench/inventory',monthlySales:'/workbench/monthly-sales',task:'/workbench/task',logs:'/workbench/logs'},purchase:{orders:'/orders',transfers:'/transfers',transfer:'/transfers/'+encodeURIComponent(id),verification:'/transfers/'+encodeURIComponent(id)+'/verification',edits:'/edits',edit:'/edits/'+encodeURIComponent(id)},sales:{report:'/report',ledger:'/ledger',edits:'/edits',edit:'/edits/'+encodeURIComponent(id)},overview:{overview:'/overview',dashboard:'/dashboard',bills:'/bills',edits:'/edits',edit:'/edits/'+encodeURIComponent(id)},exporter:{tasks:'/tasks',task:'/workbench/tasks/'+encodeURIComponent(id),orders:'/tasks/'+encodeURIComponent(id)+'/orders'}};
    const route=paths[desk]?.[kind];if(typeof route!=='string')throw Error('不支持的只读查询');
    const search=new URLSearchParams(query).toString();return manager.request(desk,route+(search?'?'+search:''));
  },
  async prepare({desk='purchase',kind='transfer',id,source,decisions,revision,edit}){
    if(kind==='edit')return manager.request(desk,'/edits',{method:'POST',body:edit});
    if(desk!=='purchase'||kind!=='transfer')throw Error('导入草稿只能交给采购台');
    return id?manager.request(desk,'/transfers/'+encodeURIComponent(id),{method:'PUT',body:{decisions,revision}}):manager.request(desk,'/transfers',{method:'POST',body:source});
  }
});
export const actions=createActions(new ServiceManager());
