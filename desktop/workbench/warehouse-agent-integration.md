# 云仓 Agent 接线与验收

本组仅实现模块领域及适配器，不接大模型、launcher、preload 或 gateway。原正式模式旧入口继续可用；Agent管理模式禁止旧直接执行、发送及员工配置写入口，统一走中央审批。Beta不同时启用旧定时器和Agent定时器。

## 工厂

主机侧 `createWarehouseAgentAdapter({transport})`，工厂文件 `warehouse-agent.mjs`。transport 严格使用统一签名契约：

```js
transport('warehouse', '/api/integration/v1/agent/'+operation, {
  method:read?'GET':'POST', body:read?undefined:{...body,taskId:ctx.taskId}, ctx, signal:ctx.signal
})
```

operation 为 `binding/query/prepare/commit/receipt`。binding/query/receipt 使用GET并把{...body,taskId}编码到payload查询参数；prepare/commit使用POST。这样只读查询不要求采集任务执行权。模块侧用同一工厂：

```js
createWarehouseAgentAdapter({
  databasePath, // 现有 Beta 副本的 data/erp.sqlite，必须已有 ledger-instance
  workspace, // 该副本 workspace，不得指向原正式目录
  nodePath, // module runtime node；Electron 时可用 ELECTRON_RUN_AS_NODE
  getEnvironment, // async()=>现有 buildEnvironment 对等环境，凭据仅主机注入子进程
  verifyApproval, // 中央 approval.mjs 的 verifyAgentApproval
  workbenchKey, // 模块自己的.workbench-key字符串或async读取器
  senders, getChannels // 原 warehouse-reminder-senders 的真实渠道和配置状态
})
```

`warehouse-agent-api.mjs` 导出路由清单及 `createWarehouseAgentRequestHandler(adapter)`，签名入口调用 `dispatch(operation,body,ctx)`。ctx.actor 必须是模块重新验证的 actor；taskId来自可信主机任务上下文；approval从专用请求头解析；idempotencyKey来自可信请求头。模型不能提供这些值。不使用旧UI channel或review cookie。服务端原有维护模式、令牌和签名校验必须保留。commit必须映射proof的中央resultId/resultVersion；运行时提交的step携带commitData.preparedId定位模块持久准备结果，digest核对全部input/commitData/changes。

模块自己的 binding 对 WAREHOUSE_TABLES 业务行和settings.json/secrets.bin文件摘要确定性哈希，不含 Agent 准备及回执表（不会返回密钥）；主机须使用 `/agent/binding`，不能拿旧 capability revision 替代它。

## 能力与真实实现

`inventory/sales/daily/sources` 查询；`inventory.collect/import/send` 和 `sales.collect/import/backfill/send` 分阶段；`attendance.check-in/complete` 保留本人身份；`employees.configure/remind` 保留管理员、工作日及渠道限制；`backup` 在prepare内即使用SQLite backup API生成可下载原件，不需commit才生成；collect与backup的requiresReview:false步骤只整理产物，不写业务账或发送。

collect复用原Playwright采集器，把原件复制到受控目录、记录SHA256并用原校验器验证，不写库存或发群。import重验原件与业务修订，先备份再调用原导入器；多月原导入器逐月事务，失败明确返回partial及已完成月份，不能报告整批成功。inventory.import建立真实日结批次及当前快照指纹；send绑定该指纹、校验ID和预览内容。签到/完成不伪造UI channel，只有中央验签通过后的内部调用可使用approvalVerified，普通旧入口限制保持。

`warehouse_agent_artifacts/prepared/receipts` 是追加的模块执行表。原件留 workspace/agent-warehouse/sources，备份与worker任务也只留该副本。commitData不得交给模型/UI。公开证据目前提供artifactId、SHA256及原表格校验；已接通签actor鉴权的GET `/api/integration/v1/workbench/agent-files/:artifactId?payload={taskId}` 二进制stream下载，按原件拥有者限制且重验SHA256。动态manifest已登记download，host可通过该受控流注册中央artifact；没有任意路径读取入口。

## 回执与失败

先持久占用幂等键为unknown，再执行副作用。回执`{state,receipt}`（partial/unknown领域结果统一state=unknown，但receipt.status和分项结果保留，不让host误当HTTP失败丢失证据）支持重启回查。相同key不同准备结果拒绝。未知、部分成功和未配置不能被runtime当完成；不自动重试未知短信、电话或群发送。月报和提醒渠道都必须有明确受理号，空响应留unknown。库存和月报还按已保存业务发送记录跨任务去重。尚无供应商查询API的unknown需在服务商核查，不能自动推定失败后重发。

## 旧22点调度接管（模块已实现，host启用）

用户明确保留电脑本机时间每天22:00；业务日/来源日期/签到截止仍用Asia/Shanghai。host必须只对Beta模块子进程注入`LINGTU_AGENT_MANAGED=1`：模块main已在此模式停止旧日/月timer并完全不创建旧自动催办interval，状态返回schedulingOwner=agent。源设置文件保持原22:00及开关不变，原正式模式和运行逻辑保持不变。host再按旧设置创建唯一新调度，持久记录时区及接管标识，并核对新调度创建成功才标记接管。不能修改正式settings.json。新调度启动时也必须获取旧state/desktop-task.lock；本适配器已复用该锁，遇遗留锁只阻止并提示核查，不自行删除。旧自动催办不能与新审批队列并跑。

## 用例与边界

运行 `node --test tests/warehouse-agent.test.mjs tests/warehouse-daily.test.mjs tests/warehouse-daily-http.test.mjs tests/warehouse-reminder-senders.test.mjs tests/warehouse-monthly-sales.test.js`。独立工作树尚未合入中央helper时设置AGENT_APPROVAL_HELPER为中央approval.mjs实际路径；整合后无需该变量。

用例使用真实临时SQLite、真实XLSX解析/库存/月销导入、真实中央HMAC验签及真实SQLite备份；不把合成用例当真实菜鸟采集或通知投递验收。浏览器登录/挑战、跨设备Tailscale、真实模块HTTP的准备→HMAC审批→入库→回执→下载已通过用例，Electron双模式也已验证。跨模块host完整接线、中央结果页和供应商真实发送仍需集成验收。任何未接通项应列为未验收，不能用mock宣布完整业务完成。
`node tests/warehouse-agent-electron.mjs`验证真实Electron进程Agent与legacy双模式：同样的22点设置，legacy有排程，Agent无旧日/月timer及旧自动催办，配置保持不变。中央runtime普通员工的签到/完成不应被全局canRunTasks限制；模块领域保留了这一差异，host/runtime需相应区分。
主机transport当前通用请求超时为120秒；真实菜鸟导出+自动续登可能超过此值，需集成组按任务设置更长请求预算并保留AbortSignal。模块已处理断连取消并仅终止本次worker进程树，不会杀其他模块进程。
