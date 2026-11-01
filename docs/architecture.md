# 五成 ERP 当前功能架构

唯一维护主线：轻量业务工作台。程序保留独立预览身份；不包含内置模型、对话执行器或自主任务引擎。文档描述源码能力；本轮是否可交付以[验收规则](verification.md)和绑定当前源码、安装器摘要的实测报告为准。

## 功能与模块

模块清单唯一来源：[desktop/product/modules.mjs](../desktop/product/modules.mjs)。运行时、构建和验收共用稳定 ID；工作台保留采购、销售、经营三个内嵌入口，并恢复侧栏“云仓同步”入口；云仓打开独立业务窗口，订单导出模块继续保留，采购内的订单导出子工具不受影响。

| 功能 | ID | 源码 | 程序入口 | 显示形态 | 数据库相对模块数据目录 |
|---|---|---|---|---|---|
| 云仓同步 | `warehouse` | [core](../core/) | `desktop/main.mjs` | 独立窗口 | `workspace/data/erp.sqlite` |
| 采购台 | `purchase` | [apps/purchase](../apps/purchase/) | `server.mjs` | 工作台内嵌 | `purchases.sqlite` |
| 销售台 | `sales` | [apps/sales](../apps/sales/) | `server.mjs` | 工作台内嵌 | `sales.sqlite` |
| 经营收支总览 | `overview` | [apps/overview](../apps/overview/) | `server.mjs` | 工作台内嵌 | `overview.sqlite` |
| 订单导出 | `exporter` | [apps/exporter](../apps/exporter/) | `runtime/resources/app.asar` | 独立窗口 | `orders.sqlite` |

| 功能范围 | 源码实现 | 自动验证入口 | 真实服务状态 |
|---|---|---|---|
| 云仓库存、销量、补货、钉钉提醒 | 已实现；[功能说明](feature-manual.md) | `verify:quick` 云仓组；发版另跑界面与隔离账本 | 本轮未执行真实菜鸟登录、采集或发送 |
| 采购手工记账、表格导入、原始附件 | 已实现 | 采购模块测试与集成验收 | 本轮真实平台下载待验证 |
| 销售记账、运费、运营数据 | 已实现 | 销售模块测试与集成验收 | 本轮真实店铺与菜鸟下载待验证 |
| 经营收支、原始单据核对 | 已实现 | 总览模块测试与集成验收 | 不把缺失数据视为零；平台归档待验证 |
| 历史订单导出、Excel 文件 | 已实现 | 导出模块测试、真实导出界面与 XLSX 回读 | 本轮真实订单平台待验证 |
| 外部 MCP/CLI、人工复核 | 已实现；[业务接口](../desktop/business-interface/index.mjs) | 接口、防伪确认与已安装程序检查 | 不恢复内置 AI Harness |
| 模块按需下载、取消、续传、校验激活 | 本轮实现；[准备流程](../desktop/business-host/on-demand.mjs) | 签名、摘要、依赖、恢复和网络故障测试 | 新版本未发布时下载地址不可用；不得宣称已联网交付 |

“自动验证入口”是覆盖来源，不代表每次执行都通过。成功、失败、跳过、未执行必须在报告中分别列出。

## 本轮功能收敛

下列删减来自用户确认，唯一清单为 [retired-features.mjs](../desktop/product/retired-features.mjs)。

| 编号 | 已停用功能 | 保留范围 |
|---|---|---|
| A2 | 一键打开全部 | 移除工作台批量启动及其 IPC |
| A4 | 工作台订单导出快捷入口 | 仅移除工作台入口，导出模块与采购采集/导入入口保留 |
| A5 | 跨模块来源穿透与返回 | 保留本模块明细、原件下载与外部业务接口 |
| B5 | 经营待补数据与完整性确认 | 停用新确认，不删除历史记录；缺失金额不当作零 |
| C33 | 图片/PDF/OCR 单据识别 | 保留手工录入、表格导入、普通附件与历史来源 |
| C9 | 采购设置、备份与使用帮助入口 | 保留采购管理中的供应商、地址、月度确认和日志；公共备份保留 |
| D8 | 销售自动任务与模块备份入口 | 不再创建月度自动任务；保留历史报表、月结和公共备份 |
| H1 | 内置 AI 对话、模型代理及 Codex/Hermes 执行器 | 外部 MCP/CLI、人工结果复核与业务适配器保留 |
| H2 | 云仓签到与考勤 | 保留历史表与库存同步批次，不再签到、配置或催办 |
| H3 | 完整离线安装包生产路线 | 不新增完整离线包；不删除历史安装器；日常从源码启动 |
| P1 | 权限管理 | 不再分配角色、模块或任务权限；已认证公司成员同权，登录与签名校验保留 |

## 进程与接口

- Electron 外壳管理窗口、预览身份、组件准备与共享服务。采购、销售、经营共用 Node 服务宿主，各自 Worker、端口和账本；云仓和导出复用同一 Electron 可执行文件打开独立窗口。
- 预览数据固定在 `%LOCALAPPDATA%/WuchengAgentBeta-preview`，下设 `profile`、`data/<id>`、`programs/<id>` 与 `registry.json`。预览网关 27430，模块 27431–27479，采购移动端 27480。程序不得改指正式目录。
- 服务入口与权限由 [ServiceManager](../desktop/shared/service-manager.mjs)、[身份校验](../desktop/business-host/isolation.mjs)及 [业务传输](../desktop/business-interface/module-transport.mjs)控制；外部输入不能伪造已确认状态。
- 外部 MCP/CLI 经工作台 dispatcher 调用业务接口，写入仍经过结果复核及回执核对；不绕过原模块的数据口径。
- [共享 Loading](../desktop/shared/loading-screen.mjs)接收模块、状态和真实进度；修改后运行 `node scripts/sync-loading-assets.mjs`，不在各页复制样式。

## 构建、启动与分发

- [开发入口](development.md)：Turborepo 管理 host、云仓、采购、销售、经营、导出任务及其缓存。安装器、签名、扫描和实机验收不复用成功结论。
- 默认只生产轻量预览安装器。模块及其固定运行时通过同一版本 GitHub Release 分发；不再生产完整离线安装包，不使用用户 3 Mbps 服务器分发大文件。
- 启动验证随包宿主；首次打开某模块才下载并准备它和缺失依赖。签名、摘要、兼容性、路径保护及原子注册仍是放行条件。下载失败显示失败，可取消和重试，不能显示为模块已就绪。
- 同一 Electron 版本取导出模块锁定分发。语言包只保留 zh-CN 与 en-US；GPU 回退、编解码器、ICU 和许可证保持原样。
- [发布规则](release-packaging-policy.md)与[运维边界](operations.md)是当前规范。旧路线文档已删除，历史仅从 Git 追溯；机器可读覆盖清单保留供原有工具使用。
