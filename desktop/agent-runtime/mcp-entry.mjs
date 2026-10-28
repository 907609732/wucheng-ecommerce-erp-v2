import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const url=process.env.ERP_AGENT_BRIDGE_URL,token=process.env.ERP_AGENT_BRIDGE_TOKEN;
if(!/^http:\/\/127\.0\.0\.1:\d+\/invoke$/.test(url||'')||!/^[a-f0-9]{64}$/.test(token||''))throw Error('Missing private ERP task bridge');
const server=new McpServer({name:'wucheng-erp-task',version:'1.0.0'},{instructions:'只通过本服务完成公司任务。查询和整理结果可自动执行；正式入账或发送由 ERP 结果页人审提交，本服务没有审批工具。未开通能力必须报告未开通。'});
const schemas={erp_capabilities:z.object({}),erp_query:z.object({module:z.string(),capabilityId:z.string(),input:z.record(z.string(),z.json()).default({})}),erp_prepare:z.object({module:z.string(),capabilityId:z.string(),input:z.record(z.string(),z.json()).default({})}),erp_task_result:z.object({}),erp_ask:z.object({question:z.string().min(1).max(3000)})};
for(const [name,inputSchema]of Object.entries(schemas))server.registerTool(name,{description:({erp_capabilities:'查询当前任务和人员可用的业务能力及输入参数',erp_query:'执行登记的只读业务查询并生成有来源的结果',erp_prepare:'采集、整理并校验业务结果，提交前等待人审',erp_task_result:'读取本次任务的实际结果和证据',erp_ask:'缺少业务范围或存在不可推断异常时请求人员补充'})[name],inputSchema},async input=>{
  try{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({name,input}),signal:AbortSignal.timeout(600000)});const result=await response.json();return {content:[{type:'text',text:JSON.stringify(result)}],...(!response.ok?{isError:true}:{})};}
  catch{return {isError:true,content:[{type:'text',text:JSON.stringify({code:'ERP_BRIDGE_UNAVAILABLE',message:'任务连接已中断；不能据此假定业务成功。'})}]};}
});
serveStdio(()=>server);
