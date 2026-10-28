# Agent 主界面承接清单与验收边界

记录日期：2026-10-28。只读核对的主集成快照为 `18e1dfb30780959b90d03d61eac344003a38907e`；后续主机、运行时和模块增量仍在合入。本文件是必要接线与待验收清单，不是完整功能通过证明。

**当前存档点：用户要求现在保存、下次继续，并立即提供半成品查看。停止新增 UI 改进与测试，只提交已写代码及常驻“开发预览 · 功能未完成 · 未迁移正式账本”标识。本次半成品展示不改变正式账本，不能按全功能验收版发布。**

用户最新要求为“先去掉所有中间的测试，全部改完再测试”。收到此要求后停止中间测试、真实 Electron 验收和新增试运行。保留已有测试源码与结果，以下新增修正尚未执行测试；代码冻结后统一验收。

## 证据边界

| 层级 | 已有事实 | 不能据此宣称 |
|---|---|---|
| 源码接线 | 旧入口、模块 capability、主机桥与新结果渲染已做必要对照 | 真实模型能够正确规划所有业务；真实平台采集成功 |
| 合同浏览器检查 | `tests/agent-workspace-ui.mjs` 在 `f27e67d` 时通过：任务输入、结果复核、设置权限、连接差异、失效重取、拒绝 8443、390px、共享进度条 | 当前新增结果渲染、私网登录、诊断入口已经实机通过 |
| 真实运行时＋模拟引擎 | `tests/agent-workspace-runtime.mjs` 在 `f27e67d` 时通过：真实 SQLite 持久任务、严格回执回读、未知状态不重写、历史结果只读、分派与附件、只读查询及写入拒绝、定时任务 | 五个真实业务适配器已经全部通过同一 UI；自然语言自行识别员工；真实公司 API 已通过 |
| 真实 Electron／完整模块／安装包 | 尚待代码冻结后的统一验收 | 可交付安装版、全功能完成或迁移正式账本完成 |

本轮未使用个人 AI 配置、正式账本或真实平台账号操作。截图目录中的已有截图只支持其生成时的 UI，不支持本轮新增代码。运行时测试使用已知合成员工 ID，因此不证明自然语言姓名解析与真实员工目录已打通。

## 覆盖矩阵的实际状态

已读取 `docs/agent-beta-coverage.json` 和 `scripts/agent-beta-coverage.mjs`。矩阵生成时间为 `2026-10-28T10:31:20.024Z`，所有条目当时均为 `pending`：

| 模块 | 条目总数 | 业务／控制 | UI 导航 | UI 资源 |
|---|---:|---:|---:|---:|
| 云仓 | 17 | 14 | 1 | 2 |
| 订单导出 | 20 | 17 | 1 | 2 |
| 采购 | 170 | 95 | 8 | 67 |
| 销售 | 285 | 91 | 139 | 55 |
| 经营总览 | 79 | 61 | 3 | 15 |
| 合计 | 571 | 278 | 152 | 141 |

这些是旧 manifest 的入口数量，**不是 571 项独立用户功能，也不是当前 capability 数量**。分类依据旧 `kind` 和资源扩展名，不能把标为 UI 的路径直接认作可废弃业务。

在停止中间测试要求到达前，覆盖检查返回 7 个阻断项：缺少 routes/UI/CLI/MCP 动态对照证据、全局源码摘要变化、五个模块清单均过期。此状态说明证据需在代码冻结后重新对照，不能推出所有模块均未实现；也不能用本文件或静态扫描把它们改成 `verified`。本轮不改覆盖矩阵或伪造 `docs/agent-beta-evidence`。

## 旧入口到统一任务的必要映射

| 旧入口／用户目的 | 新入口与执行能力 | 共享主界面承接 | 当前边界 |
|---|---|---|---|
| 主页五个模块卡片 | 首页目标输入 → 同一任务空间；主机 `composition.mjs` 组装五个业务适配器 | 输入、资料、执行动态、待处理、最近任务、历史、结果及统一确认 | 不再依赖返回旧模块页面找业务按钮；实际全业务路径待统一验收 |
| 旧“老板／员工”自选身份 | `status.actor` 与主机真实人员解析 | 显示已认证人员；无自选老板按钮 | 测试账本隔离、实际私网员工身份须由主机验收 |
| 设置里的员工权限 | `permissions.get/save`，带配置 revision；系统任务 `permissions.update` | 维护独立登录身份、角色、模块、执行权限 | UI 权限编辑与自然语言人员查找不同；后者缺成员查询能力，见后文 |
| 查询与普通员工目标 | `tasks.create`；运行时逐 capability 授权 | 输入框不再因 `canRunTasks=false` 整体禁用；按 `review.canApprove` 控制确认 | 既有模拟查询通过；云仓本人签到等例外的真实模块流程待统一验收 |
| 公共资料上传 | `attachments.upload` → `task.attachmentIds` → `ctx.resolveAttachment` | 50 MiB／文件、单批最多 20 份、空文件提示、补充资料 | 主机任务附件必须转换为模块受控原件；不能让模型凭空生成 Base64 或本机路径 |
| 采购原件／OCR／表格导入 | `files.upload(.part)`、`attachment.stage`、`import.analyze/remap/commit`、`ocr.start/status/commit` | 表格、来源、异常、补充要求与确认 | 采购允许行无 columns；本轮已补推导列显示。原件暂存桥与真实 OCR 仍需全链路证据 |
| 采购月度任务与月结 | `tasks`、`months`、`task.action`、`task.mark`、`month.confirm`、`month.cancel` | 任务结果展示、来源、操作参数、统一复核、回执 | 不把系统任务分派与采购领域任务验收混为一项；两条业务分别验收 |
| 销售月度任务／员工交接 | `sales.task-center`、`sales.staff-handoff` | 任务状态、业务资料、差异、确认 | 交接不等于老板完成资金审核；待真实领域结果接入验收 |
| 销售月结 | `sales.close-preview`、`sales.close-history`、`sales.month-lock`、`sales.month-unlock` | 最新结果、版本、异常、明确确认和回执 | 已锁月、来源修订变化、解锁原因应由领域服务核验；UI 不猜金额或遗漏条件 |
| 销售账单／运费原件 | `sales.file-stage`、`sales.file-inspect`、原件导入、`sales.freight-attachment`、菜鸟预览及入账 | 添加资料、结构化结果、登记文件下载与确认 | 商家寄件／顺丰的自动平台采集占位不能标为已实现；手工原件处理能力与自动平台采集分开 |
| 经营总览月报／月度完成度 | `overview.report/dashboard/details`、`overview.coverage`、`overview.snapshot-create` | 表格、来源、实际费用／付款登记结果 | 月报快照不等于销售锁月；付款登记不等于银行转账 |
| 订单导出任务 | exporter 的 `state/task/orders/snapshot/logs/start/pause/resume/retry/finish/enrichDetails/export/transfer` | 任务目标、动态、真实任务状态、分页元数据、产物下载 | exporter 当前返回 JSON；本轮已补显示。平台登录／验证码仍由实际人员完成 |
| 分派同一个 Agent 任务 | system `tasks.assign` | 统一复核、任务编号和当前负责人；接受者继续同一任务 | 已知 ID 的分派链路已有模拟证据；真实姓名到可分派成员 ID 尚缺查询入口 |
| 定时任务 | `schedules.*` 及系统任务同名能力 | 每天／工作日／每周／每月、时区、已有 Cron 回填、暂停、历史结果 | 计划修改绑定版本；能力范围及创建者权限在服务端验证 |
| 公司模型与引擎 | `settings.get/save`，`status.engines[].supportedModels` | Codex 兼容下拉；Hermes 按主机合同填写公司模型；保存只写密钥 | 兼容清单不表示公司 API 已开通；切换引擎不擅改模型 |
| 公司私网 | `connection.get/check/plan/save` 与原有受限 `networkLogin/Connect/Status/Logout` preload | 9443 校验、公司主机差异确认；本轮接回内置私网首次登录／重连／退出 | 此增量未测试；主机验证官方登录 URL 与身份，UI 不读取登录凭据 |
| 日志与诊断 | 原有 `readLogs/copyLogs/exportLogs` preload | 本轮新增设置页折叠入口 | 此增量未测试；当前承接最近日志和诊断导出，不宣称具备所有旧筛选交互 |
| 模块／运行环境安装、升级、旧独立账本迁移、开机启动写入 | Beta 主机 `launcher-policy.mjs` 和独立打包迁移工具 | 不重新开放已被 Beta 禁用的维护按钮 | 属于主机明确禁用或交付工具维护范围，不能误计为 UI 已完成的普通 Agent 业务 |
| 业务备份 | system `backups.create` 及各领域备份能力 | 备份说明、问题、清单或登记的文件产物 | 当前系统备份报告明确不含公共权限／任务／调度等完整公共状态；清单 JSON 不是完整安装迁移包 |

## 已明确修正、尚未测试的 UI 接线

1. **无 columns 表格**：从真实行字段推导列名，保留金额分单位字段，不再渲染空表。既有明确 columns 优先。
2. **异构结果**：显示 `json.data`、`job`、`file/download`、未知结构块及嵌套记录；来源资料可展开查看单位、摘要、分页范围。
3. **异构变更**：只有真实 before/after 才展示前后对照；`operation/input/preview`、采购新增行等按原结构展示，避免整行“—”冒充已核对差异。
4. **文件边界**：`file/download` 仅有明确登记的 `artifactId` 才产生下载动作；不能把领域 `fileId` 或 `downloadUrl` 直接传给 `artifacts.open`。未登记时明确提示尚不可下载。
5. **可恢复的设置入口**：内置私网登录、重连、退出与最近日志／诊断通过既有受限 preload 接线；浏览器终端无对应能力时隐藏本机操作。

## 代码冻结前需完成的跨组接线

以下为下次续接待办，当前不继续实施；各组后续提交可能已完成其中部分，恢复时以集成代码核对，不能仅凭本清单重复开发。

| 项目 | 责任边界 | 必要完成条件 |
|---|---|---|
| 领域产物登记 | 主机＋模块 | 模块调用已提供的 `transport.download(moduleId,route,{ctx,...})`，通过允许列表、身份、摘要、大小校验后登记任务 artifact；返回 UI 可用的 `artifactId`。主机组已提供 helper，不等于所有模块调用点已接上 |
| 任务附件转领域原件 | 运行时＋主机＋模块 | 读取任务绑定附件，由受控代码暂存／分片到采购、销售、总览。模型只引用受控 ID；不借助任意文件工具，不把原件字节扩写进提示词 |
| 员工查询与名称消歧 | 运行时＋身份 | 提供可分派人员的最小 `id/label/范围` 查询；同名时请求用户选择，不读取他人业务数据，不要求模型猜登录账号 |
| 人员主数据与旧任务关系 | 主机＋领域 | 全局登录授权与采购／销售原有领域人员、任务归属有明确映射。设置里的模块复选框不能替代领域历史归属迁移 |
| 完整备份／迁移数据 | 主机＋打包迁移 | 按最终迁移计划涵盖正式账本、附件、审计、权限、任务及关联；现有业务备份清单不作为完整迁移通过证明 |

## 留待最终统一验收的体验项

- 在真正 Electron 中使用五个真实领域服务完成查询、资料导入、结果复核、下载、月结与解锁；两个引擎均需实际业务证据。中途重启／断网／权限撤销／未知回执不得把失败显示成成功。
- 验证实际员工通过内置私网完成首次登录、连接 9443、权限生效；正式 8443 入口不受影响。UI 按钮出现不算登录或连接通过。
- 在 390px、键盘操作及真实长表格／嵌套业务结果中复核本轮新增渲染；旧截图不能代替该项。
- 当前共享结果表只读，修改通过补充目标重新准备版本；没有单元格编辑器。当前结果文件走受控下载，尚无内嵌图片／PDF 原件预览；图表块也没有专门协议。若最终体验要求必须原位编辑、展开原件或交互图表，应在冻结前补齐明确协议，不以通用 JSON 展示替代。
- 模块返回分页范围时需由 Agent 继续查询，最终结果须明示完整性；仅展示第一页不能声称全量订单已处理。
- 本报告不填充发布门禁的 `realExecutionEvidence`；最终证据必须来自实际执行且与冻结源码摘要对应。

## 核对来源

- 旧主页与设置：`desktop/launcher/index.html`、`desktop/launcher/preload.cjs`。
- 新共享 UI：`desktop/launcher/agent-index.html`、`agent-api.mjs`、`agent-workspace.mjs`、`agent-workspace.css`。
- 运行时与主机：`desktop/agent-runtime/index.mjs`、`system-adapter.mjs`、`desktop/agent-host/composition.mjs`、`launcher-policy.mjs`、`module-transport.mjs`、`backups.mjs`。
- 领域协议：`apps/purchase/docs/agent-native/coverage.md`、`apps/exporter/docs-agent-capabilities.md`、`apps/overview/docs/agent-native.md`，以及各模块 `agent-adapter`、`agent-service`、`agent-actions/operations/files`、`agent-schemas` 源码。
- 发布门禁：`docs/agent-beta-coverage.json`、`scripts/agent-beta-coverage.mjs`。本次不修改其证据状态。
