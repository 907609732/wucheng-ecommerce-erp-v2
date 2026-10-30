import {fromJsonSchema} from '@modelcontextprotocol/server';
import {latestCompleteMonth} from '../../core/erp/monthly-sales-dashboard.js';

const text=(description,maxLength=160)=>({type:'string',description,minLength:1,maxLength});
const month={...text('完整自然月，格式YYYY-MM，例如2026-09；采集、导入、发月报只允许已结束月份',7),pattern:'^[0-9]{4}-(0[1-9]|1[0-2])$'};
const artifact={...text('先前采集/来源查询返回的模块原件artifactId；不能填写文件路径或中央下载产物编号',36),pattern:'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'};
const jobId={...artifact,description:'持久采集jobId。只回查或明确重试同一编号；未知任务不能通过省略编号重新启动'};
const login={...text('员工本人的真实Tailscale登录标识，须与工作台成员账号一致',254),pattern:'^[^\\s,]+$'};
const channels={type:'array',description:'通知渠道：email邮件、dingtalk钉钉、sms短信、phone语音电话；按服务商配置决定是否可用',uniqueItems:true,maxItems:4,items:{type:'string',enum:['email','dingtalk','sms','phone']}};
const closed=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const employee=closed({login,name:text('员工显示姓名',80),email:{type:'string',description:'邮件接收地址，不启用邮件可留空',maxLength:254,pattern:'^$|^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$'},mobile:{type:'string',description:'短信和语音接收手机号，可含国家代码前缀+；不启用可留空',pattern:'^$|^\\+?[0-9]{7,18}$'},dingtalkUserId:{type:'string',description:'钉钉员工User ID；不启用钉钉可留空',maxLength:128,pattern:'^[^\\r\\n]*$'},task:text('每天需完成的具体工作内容',500),deadline:{type:'string',description:'每日任务截止时间，按北京时间Asia/Shanghai解释，格式HH:mm',pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'},workdays:{type:'array',description:'工作日：1周一至7周日；空数组表示没有工作日',uniqueItems:true,maxItems:7,items:{type:'integer',minimum:1,maximum:7}},channels,enabled:{type:'boolean',description:'是否启用该员工任务；停用不催办'}},['login','name']);

export function warehouseCapabilitySchema(id){
  switch(id){
    case 'sales':return closed({from:{...month,description:'查询起始月份（含），默认最近12个月'},to:{...month,description:'查询结束月份（含），默认最近完整月；跨度最多120个月'},sku:{type:'string',description:'按SKU或品名筛选，留空查询全部',maxLength:160}});
    case 'sources':return closed({artifactId:artifact});
    case 'logs':return closed({level:{type:'string',enum:['any','error','warning','info'],description:'日志级别，默认any'},query:{type:'string',maxLength:100,description:'普通文本关键词，不支持正则或文件路径'},limit:{type:'integer',minimum:1,maximum:100,description:'最近日志条数，最多100，默认30'}});
    case 'collection.jobs':case 'inventory.collect':return closed({jobId});
    case 'collection.retry':case 'collection.cancel':return closed({jobId},['jobId']);
    case 'inventory.import':case 'sales.import':return closed({artifactId:artifact},['artifactId']);
    case 'sales.collect':return closed({month,jobId},['month']);
    case 'sales.send':return closed({month},['month']);
    case 'sales.backfill':return closed({from:{...month,description:'补齐范围起始月份（含），只采集缺失或未验证月份'},to:{...month,description:'补齐范围结束月份（含），须不早于from，跨度最多120个月'}},['from','to']);
    case 'attendance.complete':return closed({note:{type:'string',description:'本人核对库存及处理预警的说明，可留空；不能代他人确认',maxLength:500}});
    case 'employees.configure':return closed({employees:{type:'array',description:'完整员工名单，替换原云仓任务安排；不授予工作台成员权限',maxItems:300,items:employee},autoRemind:{type:'boolean',description:'是否期望截止后自动催办；Agent模式由统一调度接管，旧催办timer不会启用'}},['employees','autoRemind']);
    case 'remind':return closed({logins:{type:'array',description:'本次催办员工登录标识，只处理工作日尚未完成人员',minItems:1,maxItems:300,uniqueItems:true,items:login},channels:{...channels,minItems:1}},['logins','channels']);
    default:return closed();
  }
}

const compiled=new Map();
export async function validateWarehouseAgentInput(id,input,{now=new Date()}={}){
  let validator=compiled.get(id);if(!validator){validator=fromJsonSchema(warehouseCapabilitySchema(id))['~standard'];compiled.set(id,validator);}
  const result=await validator.validate(input);
  if(result.issues?.length)throw Object.assign(Error('云仓参数不符合能力契约：'+result.issues.map(i=>i.message).slice(0,4).join('；')),{code:'WAREHOUSE_INPUT_INVALID',statusCode:400,workbenchPublic:true});
  const fail=message=>{throw Object.assign(Error(message),{code:'WAREHOUSE_INPUT_INVALID',statusCode:400,workbenchPublic:true});};
  if(['sales.collect','sales.send'].includes(id)&&input.month>latestCompleteMonth(now))fail('只能处理已经结束的完整自然月');
  if((id==='sales.backfill'||id==='sales')&&input.from&&input.to){const start=Number(input.from.slice(0,4))*12+Number(input.from.slice(5)),end=Number(input.to.slice(0,4))*12+Number(input.to.slice(5));if(end<start||end-start>=120)fail('月份范围须从早到晚，且最多120个月');}
  if(id==='sales.backfill'&&input.to>latestCompleteMonth(now))fail('补齐范围不能包含未结束月份');
  const logins=id==='employees.configure'?input.employees.map(e=>e.login):id==='remind'?input.logins:[];
  if(new Set(logins.map(v=>v.trim().toLowerCase())).size!==logins.length)fail('员工登录标识不能重复（忽略大小写）');
}
