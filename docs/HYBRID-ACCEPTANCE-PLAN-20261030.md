# 三合一工作台集中验收准备

状态：只准备，未运行本文件所列测试、模型、服务、应用或包体。待总控确认本批次运行时、领域和主界面全部收敛后执行一次；只对失败范围修复复测。原有数百项已通过测试不无故全量重跑。

## 最小自动化批次

| 范围 | 复用入口 | 证明范围 |
| --- | --- | --- |
| 能力发现、Skill 版本/持久化/调度、跨 API 源密钥边界 | `tests/agent-capability-discovery.test.mjs`、`tests/agent-runtime-skills.test.mjs`、`tests/agent-runtime-settings-origin.test.mjs` | 真实 SQLite 与运行时规则；具体是否使用合成引擎按文件注明，不能转称真实公司模型 |
| 人工页面签名、原生视图生命周期 | `tests/agent-desktop-ui.test.mjs`、`desktop/launcher/personnel.test.mjs`，及本轮受影响的 `tests/agent-host.test.mjs` 用例 | HMAC 身份/来源/原生 API 契约；VM 或 fake View 的断言不等于真实 Electron 布局 |
| 采购人工月结/操作者、三台本机签名 HTTP | 采购域新增 `apps/purchase/tests/{month-locks,audit-log,workbench-gateway}.test.mjs` 相关用例；`apps/sales/test/local-desktop-workbench.test.mjs`；经营域交付的人工用例 | 人工与 Agent 提交边界、锁月/记录归属、签名本机 UI 与远程重写分支；按域交付确切文件收敛 |
| 既有结果/复核/原件/错误交互 | `tests/agent-workspace-ui.mjs`、`tests/agent-workspace-runtime.mjs`、`tests/agent-result-tools-ui.mjs` | 浏览器合成主机契约或真实任务 SQLite+合成业务；三脚本已适配默认业务台后显式进入 AI 页 |

三个浏览器脚本保留产品默认经营入口，没有靠 fixture 改回旧首页。mock `open/hide/bounds` 只用于页面契约；无须因此重跑全部业务模块。`skills.list` 仅在合成主机中明确空库，不伪造可用 Skill。

此外，`.codex-artifacts/acceptance-20261029/ui-live-sync/agent-workspace-live-sync.mjs` 是此前准备的私有脚本：它的默认页/技能 API 夹具也需与新入口一致后才可使用，不直接把旧准备文件视为已验证。

## 真实 source Electron / 三台人工流程

现有 `tests/desk-integration-ui.mjs` 已具备真实临时库、ServiceManager、人工二次核对、整数分和经营穿透流程，但硬编码旧 `Documents/ChatGPT` 源树和旧主壳，不可原样用于当前验收。

本轮准备 `tests/hybrid-source-harness.mjs` 与 `tests/fixtures/hybrid-source-electron/` 复用其方法：

- 只接受专用随机 TEMP 根及 fixture 清单，使用当前 `apps/purchase/sales/overview` 源码和预先安装的 Node/Electron；三个账本是新建的空合成账本。
- 由真实 `ServiceManager` 起独立 HTTP 服务；真实 `createHostIdentity()` 读取当前 Windows SID，仅在 TEMP 保存身份；真实 `createDesktopUiSessions`、`installDeskViews`、生产 preload 子页面和原三台 UI 处理签名/HTTP/原生视图。
- 测试入口是独立 fixture main，不调用正式/Beta 激活工具、不改用户 registry、不读取或复制用户现有 profile、密钥、账本；`managed` 标志仅满足本机 UI 签名的夹具条件，不是签名包或 Beta 发行证明。
- 外壳仍加载当前 `agent-index.html` 和真实任务 SQLite/技能 API；模型不可用，Agent 业务 transport 明确禁用，禁止保存公司密钥，也不提供自动调度执行或 Agent 正式提交。子进程使用 TEMP 内私有 home，继承环境中的模型密钥变量在启动服务前移除。只有人工三台服务是真实业务执行入口，不把 stub 模型/连接元信息写成真实 AI 通过。
- fixture 不提供云仓/订单导出、公司私网、完整主机生命周期或打包资源验收。关闭仅清理其自有三个服务；临时账本和日志保留，不删除用户数据。

待总控明确冻结后，由总控启动以下命令并保留其进程所有权，再用 Computer Use 查看唯一窗口 **“五成 ERP · 三合一隔离验收”**：

```powershell
& 'C:\Program Files\nodejs\node.exe' tests/hybrid-source-harness.mjs --launch
```

不带 `--launch` 只输出使用说明。启动日志在 `.codex-artifacts/hybrid-source-harness/<随机ID>/`；`launch.json`、`native-events.jsonl` 和关闭记录均不自动产生 pass 标记。尚未运行过该夹具，其首次启动问题仍可能需要集中阶段修复。

最少人工验收路径：

1. 首次经营台，切采购 → 销售 → 经营，核对真实页面和数据来源；切回采购不重复 loadURL，不丢原筛选、滚动或未提交表单。
2. 在 TEMP 采购台手工填一笔唯一测试单，明确金额 **123.45 元 = 12345 分**、无退款/运费和合成来源。保存后从 API/数据库只读核对金额与真实操作者审计，再在经营台对应期间核对采购来源及汇总；不能只看成功 toast。
3. 人工月结/解锁走实际登录与明确复核，不要求旧管理员密码；锁月后写入被拒绝，解锁也有真实身份/月份/修订审计。未满足业务闭月条件时应说明实际缺项，不能绕过。
4. 经营来源 `/apps/purchase/`、`/apps/sales/` 和已登记 TEMP 端口回到同一壳；旧正式 178xx 端口被阻止，原件下载仍只指向本次合成资料。夹具 preload 的 `businessSurface` 直接调用真实 `desks:surface`，`child-navigate` 由真实 owned child IPC 校验并传目标 module，不生成假的 `located`。经营的 `getContext/getDraftState/navigate` 读取实际 `window.wuchengBusinessSurface`；其他模块若未提供桥，应保留 `unsupported/openedOnly` 边界，不称已定位记录。
5. 宽窗打开 AI，原生业务区与 360px 栏不重叠；小窗在 AI 与业务之间切换。更多业务菜单、外层原件/复核弹窗、resize/缩放与快速切页均不被原生视图盖住。
6. Skill 新建/保存/启用 v1，再保存 v2，启用版本仍为 v1；真实任务固定 v1。启用 v2 不改旧任务。导入先摘要预览、CAS 冲突留编辑内容、不显示假“已验证”。该 fixture 任务应明确未配置模型，不能把暂停当成功。

## 真实 AI 与最终包体边界

用户已经在正常 ERP profile 中保存 DeepSeek key。待新代码收敛并由总控安全刷新正常窗口后，在该窗口用 Hermes 做一次最小真实只读任务：分层发现模块和单项 schema，查询 `system/schedules.list`，核对真实 step、结构化结果、最终状态及 UI 自动恢复同步。不要从 fixture 读取/搬运密钥，也不读取财务数据来检查连通性。

Codex/DeepSeek 的 namespace 兼容须以新适配和实际调用证明；本次 Hermes 通过不推广为双引擎或其他厂商通过。最终新源码包体、外置 MCP 文件、公司私网员工设备、真实平台、全部现有业务、迁移及安装/回退仍是独立门槛，不由 source fixture 或旧 stage 替代。
