/** Product removals confirmed in the feature review; historical data is retained. */
export const RETIRED_FEATURES=Object.freeze([
 {id:'A2',name:'一键打开全部',scope:'移除工作台批量启动及其 IPC'},
 {id:'A4',name:'工作台订单导出快捷入口',scope:'仅移除工作台入口，导出模块与采购采集/导入入口保留'},
 {id:'A5',name:'跨模块来源穿透与返回',scope:'保留本模块明细、原件下载与外部业务接口'},
 {id:'B5',name:'经营待补数据与完整性确认',scope:'停用新确认，不删除历史记录；缺失金额不当作零'},
 {id:'C33',name:'图片/PDF/OCR 单据识别',scope:'保留手工录入、表格导入、普通附件与历史来源'},
 {id:'C9',name:'采购设置、备份与使用帮助入口',scope:'保留采购管理中的供应商、地址、月度确认和日志；公共备份保留'},
 {id:'D8',name:'销售自动任务与模块备份入口',scope:'不再创建月度自动任务；保留历史报表、月结和公共备份'},
 {id:'H1',name:'内置 AI 对话、模型代理及 Codex/Hermes 执行器',scope:'外部 MCP/CLI、人工结果复核与业务适配器保留'},
 {id:'H2',name:'云仓签到与考勤',scope:'保留历史表与库存同步批次，不再签到、配置或催办'},
 {id:'H3',name:'完整离线安装包生产路线',scope:'不新增完整离线包；不删除历史安装器；日常从源码启动'},
 {id:'P1',name:'权限管理',scope:'不再分配角色、模块或任务权限；已认证公司成员同权，登录与签名校验保留'}
]);
