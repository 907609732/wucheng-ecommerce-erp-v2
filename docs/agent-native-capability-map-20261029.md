# Agent 真实业务动作静态对应矩阵

核对日期：2026-10-29。基于集成树 `01b40a9` 及本日正在合入的源码，只读检查旧 manifest、真实 server 路由、旧界面调用入口、CLI/MCP 和 Agent Schema/实现。**本文件不是执行验收，不修改 coverage.json 或任何 verified/evidence 状态。** 并行组后续改动需重新核对对应行。

`A` 表示源码存在对应能力、领域实现和统一适配器，仍须执行验收；`H` 表示本机维护/部署/接管入口，保留明确边界，不能当作已由 Agent 完成业务；`P` 表示明确未开通；`G` 表示发现的实现缺口或阻断。旧路由的 `uiOnly:true` 不等于功能应被删除：有等价 Agent 准备/审批接口的应走新接口，不允许直接绕过旧确认。

## 核对来源

| 编号 | 来源入口及可检查内容 |
| --- | --- |
| W1 | `desktop/workbench/descriptors.mjs:16` 云仓旧接口元数据；`:22` hostOnly |
| W2 | `desktop/workbench/warehouse-agent.mjs:23` 能力清单；`:101` 起真实查询、`:113` 起准备/提交实现 |
| W3 | `desktop/workbench/warehouse-agent-schema.mjs:13` 输入约束；`core/warehouse-agent-worker.mjs` 业务 worker |
| E1 | `desktop/workbench/descriptors.mjs:2` 导出旧接口；`:13` hostOnly |
| E2 | `apps/exporter/src/main/agent-adapter.mjs:7` 起能力/Schema；`:27` 起真实异步完成处理；`:49` 起中央下载 |
| P1 | `apps/purchase/server.mjs:94` 起旧实际路由；`apps/purchase/workbench-manifest.json` 已导出的操作基线 |
| P2 | `apps/purchase/lib/agent-adapter.mjs:68` 起能力清单；`apps/purchase/lib/agent-schemas.mjs:29` 输入约束 |
| P3 | `apps/purchase/lib/agent-operations.mjs:11`、`agent-files.mjs:80` 起领域操作；`server.mjs:279` 起组装 |
| S1 | `apps/sales/server.mjs` 实际路由；`apps/sales/workbench-manifest.json` 操作基线 |
| S2 | `apps/sales/lib/agent-schemas.mjs:66` 起逐项能力与输入；`agent-adapter.mjs:4` 对中央输出的清单；`agent-actions.mjs` 领域执行 |
| O1 | `apps/overview/server.mjs:37` 起旧实际路由；`apps/overview/workbench-manifest.json` 操作基线 |
| O2 | `apps/overview/lib/agent-adapter.mjs:10` 起能力清单；`agent-schemas.mjs:20` 输入；`agent-actions.mjs:16` 起实际执行 |
| C1 | `desktop/agent-runtime/system-adapter.mjs:10` 起公共自然语言能力；`index.mjs` 任务、审批、附件及历史 |
| C2 | `desktop/agent-host/identity.mjs` 身份；`backups.mjs:28` 起公共备份；`schedules.mjs` 接管；`activation.mjs` Beta 程序激活 |
| L1 | `desktop/shared/ai-interface.mjs:35` 旧 CLI；`desktop/mcp-server.mjs:23` 与 `:167` 起旧 MCP；`desktop/launcher/main.mjs:380` 起本机维护 IPC |

行号是核对时的导航锚点，后续提交可能位移；以文件中的能力名称/路由为准。

## 云仓：拆开采集、正式入库与发送

| 用户真实动作 | 旧入口/动作族 | 新能力或明确承接 | 状态与边界 |
| --- | --- | --- | --- |
| 查看库存、补货预警和原件校验 | GET `/inventory`、旧库存页 | `warehouse.inventory` + `sources` | A；含来源日期与校验，缺失不当零（W1–W3） |
| 查看月销量、趋势、排名和缺月 | GET `/monthly-sales` | `warehouse.sales` | A；须核对真实范围与完整月份 |
| 查看日结、本人的签到/任务与提醒 | GET `/daily`、`/task` | `warehouse.daily` | A；当前人可见范围需验收 |
| 拉取库存原件 | POST `/jobs` 的库存同步 | `warehouse.inventory.collect` | A；自动采集/校验，不隐含入库或发送 |
| 把已核验库存写入账本 | 同一旧同步流程的入库阶段 | `warehouse.inventory.import` | A；结果页确认当前原件和账本版本 |
| 拉取单月/补齐缺月销量 | POST `/jobs` 月销量/补齐 | `warehouse.sales.collect`、`sales.backfill` | A；`backfill` 内采集与提交边界须验收 |
| 导入销量原件 | 同一旧流程的入库阶段 | `warehouse.sales.import` | A；不能因下载成功宣称已入账 |
| 发库存报告或月销量报告 | POST `/send-latest-valid`、旧月报发送 | `warehouse.inventory.send`、`sales.send` | A；真实目标及供应商受理回执须确认 |
| 本人签到/确认当日工作 | POST `/daily/action` | `warehouse.attendance.check-in`、`attendance.complete` | A；绑定可信当前人，不接受模型指定他人 |
| 维护员工任务与催办设置 | POST `/daily/config` | `warehouse.employees.configure` | A；不等于授予系统登录权限 |
| 按人和渠道催办 | POST `/daily/remind` | `warehouse.remind` | A；通知准备/人审/受理回执分开 |
| 停止当前采集 | POST `/jobs/stop` | `tasks.control` 的取消/暂停 → worker AbortSignal/进程树终止 | A；W2 的 worker 取消已存在，包内真实进程须验收 |
| 刷新登录/验证码接管 | POST `/host-action`、旧 CLI login | `warehouse.login.refresh` + 人工接管 | A/H；扫码、验证码由用户处理 |
| 读取旧启用日/月/30秒计划 | 旧 settings/日结配置 | `warehouse.schedules.legacy` → host takeover → 统一 schedules | A；不得双跑、复活已删计划或猜旧创建者 |
| 备份/恢复、密钥、浏览器和目录 | hostOnly | `warehouse.backup`/公共 backup；恢复见 G2；其余 H | H/G；不能把设置页数量算业务覆盖 |

## 订单导出：列表完整性、导出产物和采购交接

| 用户真实动作 | 旧入口/动作族 | 新能力 | 状态与边界 |
| --- | --- | --- | --- |
| 查看平台、采集任务与范围 | GET `/state`、`/tasks/:id` | `exporter.state`、`task` | A；列表完整性必须来自真实 task（E1/E2） |
| 查订单、分页、来源快照与日志 | GET tasks orders/snapshot、logs | `exporter.orders`、`snapshot`、`logs` | A；不能把当前页当完整历史 |
| 新建采集、暂停、恢复、重试、结束、补详情 | POST tasks 及相应 action | `exporter.start/pause/resume/retry/finish/enrichDetails` | A；finish 保留部分结果，不冒称完整 |
| 打开平台登录或某订单 | POST `/host-action` | `exporter.host-action` | A/H；需要用户处理平台授权 |
| 生成 CSV/XLSX/图片导出并下载 | POST export、GET files | `exporter.export`、`file` | **G1：固定 maxBytes 与主机上限冲突，见下文** |
| 送交采购核对 | POST transfer | `exporter.transfer` → `purchase.transfer.*` | A；送交不等于采购正式入账 |
| 清理指定平台缓存和任务 | POST platforms clear | `exporter.clear` | A；明确审批和平台范围，保留既有导出文件 |
| 辅助代理采集及日志显示 | 本机代理/显示开关 | `exporter.proxyStart/proxyStop/hidePage/setLogging/setExecutionLogVisible` | A/H；证书/账号授权仍属本机维护 |
| 代理证书、目录、安装、更新、停止软件 | hostOnly | 保留本机维护入口 | H；不能作为普通模型可任意执行的工具 |

## 采购：原件、订单、退款、分类、月度任务与历史

| 用户真实动作 | 旧实际路由族 | 新能力 | 状态与边界 |
| --- | --- | --- | --- |
| 搜索订单/单笔与汇总 | `/api/orders`、orders id、dashboard | `purchase.orders`、`dashboard` | A（P1–P3） |
| 查原件批次、订单历史、补充说明/审计 | source、order history/supplements、order-logs | `sources`、`source.file`、`audit` | A；原件字节与审计保持只读 |
| 查询/管理供应商和店铺联系人 | suppliers、supplier-management | `suppliers`、`supplier.save` | A；更新绑定 revision，不按名称猜 ID |
| 查询/新增/修改/删除地址 | addresses | `addresses`、`address.save/remove` | A；更新绑定 updatedAt |
| 创建或修改采购、退款、物流、备注、商品项 | orders POST/PUT、note PATCH | `order.create/update` | A；金额整数分、原件/锁月规则不变 |
| 批量状态、排除支出、归属、分类/分摊 | orders attributes/classification | `orders.attributes`、`orders.classification`；复杂分摊由 `order.update` | A；批量引用逐项带 updatedAt |
| 上传附件/订单图片、原件下载和移除暂存附件 | attachments、images prepare/cache | `files.stage`、`attachment.stage`、`attachments`、`attachment.file`、`attachment.remove`、`image.prepare/cache` | A；暂存与正式单据关联不能混同 |
| Excel/CSV 识别表头、映射、预览和选单入库 | import preview/remap/commit | `import.analyze/remap/preview/commit` | A；草稿更正与新版本界面本日补齐中 |
| OCR 图片/PDF或粘贴文字识别 | `/api/ocr`、ocr id/text | `ocr.start/status/text/commit` | A；底层进程取消与原 jobId 持续查询本日补齐中 |
| 查询采集交接/核验、处理冲突、入库及撤销 | integration transfers/read/review/confirm/rollback | `transfers`、`transfer.verify/save/commit/rollback` | A；冲突决定与账号/退款依据必须显式 |
| 查询月度分派任务、分派/开始/提交/验收/退回 | task-board、action | `tasks`、`task.action` | A；全局身份到领域人员绑定本日补齐中 |
| 记录月度核对结果 | tasks | `task.mark` | A；仅管理员，员工通过本人任务提交 |
| 月结预览/历史、确认或解锁 | month-confirmations 及 batch 端点 | `months`、`month.confirm/cancel`；批量是对多平台逐项准备/确认 | A；解锁须中央审批，不能传 confirmed 绕过 |
| 查看变更并按原记录/批次回滚 | order-logs rollback-preview/rollback | `audit`、`audit.rollback` | A；版本列表与锁月保持生效 |
| 导出订单、分类、月度汇总和模板 | export/classification-export/monthly-export/template | `export` 的 kind | A；下载生成中央 artifact 后验收 |
| 创建业务完整备份 | backup | `system.backups.create` 选择 purchase | A/G2；公共恢复与产物引用仍有缺口 |
| 原本地人员身份切换、老板密码、模块打开/维护/更新 | personnel/session、admin/password、integration open/stop/maintenance、upgrade | 可信主机身份与权限替代业务会话；部署动作保留 H | H；不能用模型自选 boss/employee 恢复旧授权方式 |

## 销售：官方资金、手工渠道、运费及月报

| 用户真实动作 | 旧实际路由族 | 新能力 | 状态与边界 |
| --- | --- | --- | --- |
| 查看/维护真实店铺 | shops、pdd shops | `sales.shops`、`shop-create/delete` | A（S1/S2） |
| 查看月度任务、员工交接与资料缺口 | task-center、personnel/handoff | `task-center`、`staff-handoff` | A；全局到领域人员映射本日补齐中 |
| 查经营报告、资金核对、原币及应收 | report、reconciliation、manual-summary、ledger | 对应同名查询 | A；资金流水不冒称销售/利润，缺数不补零 |
| 查覆盖/历史范围并确认来源完整度 | sources、history-coverage、coverage | `sources/history-coverage/coverage` | A；真实零和 full 都要依据 |
| 查淘宝/拼多多资金汇总、年度表、明细、单行、导出 | taobao/pdd funds/statement/movements/export | 两平台 `*-funds/statement/movements/movement/export` | A；按真实店铺/原件/范围分页 |
| 上传官方账单、通用报表与字段映射 | taobao import、pdd import、imports preview/commit | `files.stage`、`file-inspect`、`taobao-import/pdd-import/import` | A；官方文件名、尾部核对与来源保留 |
| 待归属批次、归属纠正/取消与撤销 | pdd unassigned、imports attribution/rollback | `pdd-unassigned`、`batch-attribution`、`import-rollback` | A；不能猜店铺；锁月及重复仍拒绝 |
| 平台截图/参考余额对照 | pdd references/evidence | `pdd-reference`；原件经登记下载 | A；参考不产生资金流水或自动核对 |
| 手工销售、退款、收款/费用的增改删 | ledger | `ledger-create/update/delete` | A；原币元字符串，到账不重复计收入 |
| 结算与实际收款匹配/撤销 | matches | `match-create/delete` | A；保留真实匹配原因 |
| 运费查询、单据、附件及 Excel | freight report/records/attachments/export | `freight-report/records/record/attachment/export` | A；共用运费不重复扣资金 |
| 运费新增、更正、作废和赔付抵扣 | freight records write/void | `freight-create/update/void` | A；草稿更正须有原件，赔付负数受领域规则约束 |
| 菜鸟连接、逐月采集、暂停恢复、查任务/原件 | 内置 cainiao collector + skill | `cainiao-connect/disconnect/download-start/download-stop/download-resume/status/jobs/job/file` | A；只采集不代表正式入账 |
| 官方账单分类、同源更新和入账 | 菜鸟专用预览/入账 | `cainiao-preview/posting` | A；总览既有原件交接桥 G3 本日补齐中 |
| 商家寄件/顺丰后台自动采集 | 运费平台占位 | `skill` 明示支持范围 | P；不将手工运费能力冒称后台采集已开通 |
| 月锁/解锁、历史、参考汇率 | close、rates | `close-preview/history`、`month-lock/unlock`、`rates/rates-refresh` | A；新来源/修订需重新复核 |
| 生成、下载和追溯月报 | jobs、report-history、export、template | `job-create/jobs/job-report/report-history/export/template` | A；草稿文件不证明资料齐全 |
| 备份列表、校验与独立副本恢复 | backups | `backups/backup/backup-verify/restore-copy` | A；不覆盖正在使用的正式账本 |

## 经营总览：跨台账分析、费用和付款登记

| 用户真实动作 | 旧实际路由族 | 新能力 | 状态与边界 |
| --- | --- | --- | --- |
| 查看总览、月/年趋势、明细及来源 | overview/dashboard/details/source-records | `overview.report/dashboard/details/sources` | A（O1/O2）；来源缺失不当零，source-records 的负数搜索可由 sources 真实结果筛选 |
| 查看账单、付款、单笔原件与审计 | bills、payments、source original、imports original、audit | `bills/bill/payments/original/audit` | A；跨模块数据仍受范围约束 |
| 登记、更正、作废运费/工资/其他费用 | bills POST/PUT/void | `bill-create/update/void` | A；工资各项和金额合计由领域校验 |
| 登记已发生付款/退款，撤销登记 | bills payments、payments void | `payment-create/void` | A；仅登记，不执行银行转账 |
| 分类跨台账来源、确认待退款日期 | source-classification | `source-classify` | A；绑定 sourceHash，派生数据不直接覆写源账本 |
| 模板、导入、重映射、预览、维护回导与提交 | templates、imports preview/remap/commit | `files.stage`、`template/import-preview/import`；options.mapping 承接重映射 | A；关闭旧临时预览不构成独立业务能力 |
| 费用覆盖/真实零确认、月报快照 | coverage、snapshots | `coverage/snapshot-create/snapshot` | A；不能把销售采购源缺失改零 |
| 导出总览及运费维护表 | export、freight/export | `export/freight-export` | A；维护模板参数差异需统一验收核对 |
| 备份下载、独立副本恢复 | backups、restore | `backup/backup-file/restore-copy` | A；不覆盖当前正式账本 |
| 菜鸟归档采集及既有原件复用 | 内置 cainiao collector | `cainiao-status/start/stop/resume/jobs/job/file` | A/G3；入账唯一归销售，禁止双计 |

## 公共入口与旧 CLI/MCP 的关系

| 用户目的/旧入口 | 新承接 | 状态 |
| --- | --- | --- |
| 首页目标/附件、任务记录、补充、取消、恢复 | tasks.create/get/list/input/control + attachments.upload | A；目标真实结果与历史版本仍待统一验收 |
| 原件下载/预览、草稿更正、结构化图表 | artifacts.open/preview + corrections + chart blocks | A；本日正在补实现，不能以本矩阵声明通过 |
| 查可分派人、分派 Agent 任务 | system.people.assignable/tasks.assign | A；重名必须明确选择，不能代他人确认 |
| 人员权限 | system.permissions.list/update + 公司设置 | A；Windows SID/Tailscale 真实身份，停用即时重核 |
| 新定时任务及旧计划接管 | system.schedules.* + 受控 importSchedules | A；普通 cron 与迁入30秒规则分开 |
| 公司 API/模型额度、引擎兼容、私网地址/差异 | settings.*、connection.*、host gateway | A/H；由管理员填写配置，真实公司 API/员工设备另验收 |
| 正式入账/发送确认、回执和未知提交核对 | reviews.* + task result bindings/receipts | A；旧 CLI/MCP 的 confirmSideEffect/confirmed 不是新授权 |
| 旧 CLI status/capabilities/logs/doctor/debug-bundle、MCP inventory_* | 维护诊断入口保留；业务查询走 ERP5个受限工具 | H；不扩大引擎到任意扩展/终端 |
| 旧 workbench_query/tasks/prepare MCP | 兼容入口继续存在，但新 Agent 走 erp_capabilities/query/prepare/ask/task_result | A/H；旧“两次界面确认”文案须在统一门槛中核对，不作为新已审批证明 |
| 安装/卸载/停止模块、更新、目录迁移、证书、个人登录 | 本机维护与独立打包/迁移工具 | H；完整Beta应有可达维护/诊断入口，不要求员工学习旧业务按钮 |
| 完整公共备份及恢复 | system.backups.create + 备份/恢复基础设施 | **G2：任务产物关系和公共恢复能力仍缺** |

## 实际发现和关闭条件

1. **G1，导出中央下载上限冲突。** E2 的 `artifact()` 固定 `maxBytes:512*1024*1024`；`desktop/agent-host/module-transport.mjs:17` 默认64MiB且下载拒绝请求上限大于主机上限，host composition 未覆盖。因此小文件也可能在下载前被 `ARTIFACT_LIMIT_INVALID` 拒绝。应统一可信有效上限或受控协商，不只改提示词。已发给总控，统一验收须覆盖 export 与 file 两条入口。
2. **G2，公共备份恢复及任务产物断链。** C2 的 `backups.mjs:47` 明示未包含“任务生成物文件及其他未列明公共元数据”。任务快照会保留 result/artifact 关系，未复制文件会使恢复后的下载失效。C1 当前只登记 backups.create，未见公共备份 list/verify/独立副本恢复能力。领域自己的 restore-copy 不等于恢复中央任务/调度/权限/附件。须补受控恢复流程、路径重写及产物摘要/关系校验；登录和凭据继续另配，不应随公共备份传播。
3. **G3，总览既有菜鸟原件交接销售。** O2 能下载归档，销售 cainiao-posting 原先只接受自己的 jobId。需要可信中央 artifact→销售暂存→销售分类预览与同源入账桥。不能互传领域 fileId 或用模型拼造Excel；本日销售组正在实现，需按最终提交更新此行。
4. **动态路由/界面动作一致性尚未完成。** 本文件检查实际 server 源码但未枚举运行期服务器路由，也未操作真实 UI/CLI/MCP。不能把本矩阵直接转成 `inventoryAudit.reconciled:true`。旧 manifest 可能漏掉后加 agent/* 路由；它们多数是统一传输而非新独立业务。
5. **派生报表参数差异需统一核对。** 经营总览旧 `/api/freight/export` 支持 template 开关，Agent `freight-export` Schema 列出 period/owner/q/allPeriods，模板应经 template(kind=freight)承接而非宣称同一参数已覆盖。应分别核对维护回导表与新账模板的实际列与用途。
6. **真实执行边界仍在主清单。** 公司 API、平台登录/验证码、实际发送回执、员工设备、包内原生运行环境、当前正式数据副本准备和最终迁移，均不能从能力清单推导为完成。

下一步是修 G1–G3 并补齐本日人员/更正/预览实现，冻结之后统一执行自然语言目标→实际能力→准备/人审→实际回执/产物→回读的验收。旧资源/UI导航单独列为维护或资源，不进入“已自动完成业务”数量。
