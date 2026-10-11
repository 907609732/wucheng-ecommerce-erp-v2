# 千牛账单 RPA 取账模块 — 交接说明（给 Codex / 其他自动化调用方）

> 面向对象：需要通过程序调用本模块完成「千牛收支账单自动取数」的开发者或 AI 代理。
> 本文只描述**真实存在**的接口与脚本。文中所有路径、通道名、参数均来自仓库实际代码。

---

## 0. 一句话

项目 `五成电子商务集团ERP-V2` 是一个 Electron 桌面程序（`desktop/main.mjs`）。
本模块在它内部新增了一条**千牛账单自动取数链路**：打开千牛网页版账单页 → 核对店铺 → 设置账期 → 逐个账单类型/子类型导出 → 校验下载文件 → 落成「待核对批次」→ 人工预览确认后入账。

**两条调用路径：**

| 路径 | 适用 | 是否需要 Electron | 能做什么 |
|---|---|---|---|
| **A. 无界面账本 API** | 脚本 / CLI 批处理 | 否，普通 Node 即可 | 只有账本读写（报告、批次、预览、入账、导出） |
| **B. Electron IPC（主要）** | 抓取、取账、探针、界面联动 | 是 | 全部能力，包括驱动浏览器取账 |

---

## 1. 路径 A：无界面账本 API（不需要 Electron）

入口：`desktop/shared/finance-jobs.mjs`

```js
import { financeJob } from './desktop/shared/finance-jobs.mjs';

const dir = '<财务数据目录绝对路径>';   // 见第 5 节
const report = await financeJob(dir, 'report', shopId, '2026-09');
```

- 内部用 `worker_threads` 执行，**同一进程内、同一目录字符串的调用自动串行排队**，可以并发调用。传入统一的绝对路径；此队列不协调其他 Node/Electron 进程，也不合并同目录的不同路径写法。
- `finance-worker.mjs` 与 `finance-ledger.mjs` 只依赖 `node:fs` / `node:path` / `node:crypto` / `node:sqlite` 以及 `xlsx`、`exceljs`、`adm-zip`，**不依赖 Electron**。
- 使用 `node:sqlite`；本机已验证 Node **24.18.0**。若使用 Node 22，须确认该具体版本可直接加载 `node:sqlite`，不能仅凭主版本号认定兼容。
- 全部 operation 名（第 3 个参数之后为入参）：

```
shops | shop(shopId) | saveShop(input) | stage(shopId, filePath, name?, meta?)
inspect(token) | preview(token, options) | commit(token, acknowledged)
restore(id) | report(shopId, month) | saveDraft(shop, month, data)
export(shop, month, originalId?) | newJob(shopId, month) | finishJob(id, state, message)
recoverJobs() | due() | bill(token)
openJob(shopId, month) | updateJob(id, patch) | jobDetail(id) | jobItems(jobId)
openBatch(jobId, shopId, month, kind, plan) | addPart(batchId, meta) | closeBatch(batchId, summary)
retryPlan(shopId, month) | batchDetail(batchId) | previewBatch(batchId, options) | commitBatch(batchId, acknowledged)
activeVersion(shop, month, kind)
```

> 注意：`stage()` 只接受 `.xlsx / .xls / .csv`；`meta.batch` 存在时按批次内 digest 去重，重复文件返回 `{ token, duplicate: true }`。

---

## 2. 路径 B：Electron IPC（完整能力）

启动：

```powershell
npm run desktop          # 等价于 electron .（正式 userData）
```

或在测试隔离目录下启动（**不碰正式数据**，推荐给自动化）：

```powershell
& .\node_modules\electron\dist\electron.exe . --user-data-dir="C:\temp\erp-probe"
```

渲染进程通过 `window.inventoryApp.*` 调用（定义在 `desktop/preload.cjs`）：

| 方法 | IPC 通道 | 说明 |
|---|---|---|
| `saveFinanceShop(shop)` | `finance:shop-save` | 建/改店铺，返回店铺对象（含 `id`） |
| `getFinance(shopId, month)` | `finance:report` | 取该店该月的完整报告（jobs / batches / bills / pending / rows / history） |
| `openFinance(shopId, month)` | `finance:open` | 打开该店取账窗口（首次需人工登录） |
| `collectFinance(shopId, month, options)` | `finance:collect` | **跑取账 RPA**；`options: {retry?, resume?, kinds?}` |
| `retryFinance(shopId, month, kinds)` | `finance:retry` | 只重试失败/未完成的账单类型 |
| `cancelFinance(shopId)` | `finance:cancel` | 取消该店本次取账 |
| `probeFinance(shopId, month)` | `finance:probe` | **只读**采集页面结构（不点导出/不查询/不提交） |
| `getFinanceJob(jobId)` | `finance:job` | 任务详情含每分项状态 |
| `retryFinancePlan(shopId, month)` | `finance:retry-plan` | 返回待重试的类型清单 |
| `getFinanceBatch(batchId)` | `finance:batch` | 批次详情（含各分片文件与哈希） |
| `previewFinanceBatch(batchId, options)` | `finance:preview-batch` | 整批预览（算金额、列问题） |
| `commitFinanceBatch(batchId, true)` | `finance:commit-batch` | 整批入账（必须显式 `true`） |
| `inspectFinance(token)` | `finance:inspect` | 单个待核对文件的工作表信息 |
| `previewFinance(token, options)` / `commitFinance(token, true)` | `finance:preview` / `finance:commit` | 单文件预览/入账（非批次场景） |
| `importFinance(shopId)` | `finance:import` | 弹文件选择框导入（需要人工选文件） |
| `restoreFinance(id)` | `finance:restore` | 回滚到历史版本 |
| `saveFinanceDraft(shop, month, data)` | `finance:draft` | 保存填表草稿 |
| `exportFinance(shop, month, originalId?)` | `finance:export` | 导出填表资料 |
| `closeFinanceWindow(shopId)` | `finance:close-window` | 关闭该店取账窗口 |
| `openFinanceFolder()` | `finance:folder` | 打开财务资料目录 |
| `onFinanceChanged(cb)` | 事件 `finance:changed` | 订阅进度文案 |

> **从外部脚本驱动时**：用 Playwright 的 `_electron.launch()` 起程序，再在渲染进程里 `page.evaluate(() => window.inventoryApp...)`。参考 `tests/finance-rpa-smoke.mjs`（可运行的完整范例）。

---

## 3. 调用流程示意（字段映射与确认必须人工核对）

下面的 A–E 列映射仅为仿真文件示例，不是已确认的真实账单结构。真实文件可能包含重叠的月汇总、日汇总、收入明细；确认各文件范围互不重复之前，不可合并相加或提交入账。`confirmScope: true` 应在人工确认范围后设置。

```js
// 1) 建店（account 必填，否则取账会拒绝执行）
const shop = await api.saveFinanceShop({
  name: '店铺A',
  account: '后台可见账号',        // ★ 必须与账单页顶部显示的账号文字一致
  entity: '纳税主体', taxId: '税号',
  entityType: 'enterprise',       // enterprise | individual
  taxpayer: 'small',              // general | small
  cycle: 'monthly',               // monthly | quarterly
  startMonth: '2026-09',
  schedule: true,                 // true = 每月15日09:00自动取上月
  billUrl: '',                    // 留空用千牛默认账单页；填了必须过域名白名单
  categoryMap: {},                // 自动分类失败时的人工映射：{'页面文字':'income'|'expense'|'tax'}
  excludeSubtypes: []             // 需要排除的子类型 tab 文案
});

// 2) 打开窗口（首次人工登录；已登录则直接可用）
await api.openFinance(shop.id, '2026-09');

// 3) 只读探针：确认真实页面结构（不产生任何点击/导出）
const probe = await api.probeFinance(shop.id, '2026-09');
// probe.state: 'ok' | 'needs_login' | 'needs_captcha' | 'empty' | 'query_failed'
// probe.categories / probe.controls / probe.exporters / probe.exportCenter / probe.limits ...

// 4) 取账（会阻塞到跑完，单店单账期约 1–4 分钟）
const result = await api.collectFinance(shop.id, '2026-09');
// result.state: 'received' | 'needs_review' | 'failed'
// result.kinds[]: { kind, label, state, received, expected[], missing[] }

// 5) 查报告
const report = await api.getFinance(shop.id, '2026-09');
// report.jobs[0]        → 任务状态与分项
// report.batches[]      → 每个账单类型一个批次（含分片、完整性）
// report.pending[]      → 待核对文件

// 6) 只预览本次任务的完整批次；不要遍历历史批次直接入账
const previews = [];
for (const summary of report.batches.filter(b => b.job === result.jobId && b.state === 'complete')) {
  const batch = await api.getFinanceBatch(summary.id); // report.batches 不包含 month
  const first = batch.parts.find(p => p.state === 'staged');
  if (!first) continue;
  const info = await api.inspectFinance(first.id);
  const preview = await api.previewFinanceBatch(batch.id, {
    sheet: info.sheets[0].name,
    kind: batch.kind, month: batch.month,
    firstRow: 2, lastRow: info.sheets[0].lastRow,
    mapping: { date: 'A', gross: 'B', refund: 'C', net: 'D', expense: 'E' },
    confirmScope: true
  });
  // preview.records / preview.totals / preview.issues / preview.parts[]
  previews.push({ batchId: batch.id, preview });
}

// 展示 previews，人工检查店铺、账期、文件范围、字段映射、金额及 issues。
// 在独立的“确认入账”事件中才调用：
// await api.commitFinanceBatch(人工确认的batchId, true);

// 7) 导出填表资料
await api.exportFinance(shop.id, '2026-09');
```

### 人工介入后的续跑

```js
// 登录失效 / 验证码 / 页面不匹配 → job.state 变成对应状态，RPA 已停止
await api.openFinance(shop.id, month);              // 人工在窗口里完成登录
await api.collectFinance(shop.id, month, { resume: true });   // 从当前任务继续
```

---

## 4. 状态机与**必须遵守**的约束

### `job.state` 取值

| 值 | 含义 | 是否需要人工 |
|---|---|---|
| `running` | 执行中 | 否（等待） |
| `received` | 已收到全部待核对文件 | 否（下一步是核对入账） |
| `empty` | 平台明确提示无账单 | 否（**不等于金额为 0**） |
| `needs_login` | 登录失效 | **是** |
| `needs_captcha` | 出现验证码/滑块 | **是** |
| `needs_shop_review` | 无法确认店铺身份 | **是** |
| `needs_manual` | 页面结构不符 / 导出入口歧义 / 账期写不进去 / 超限需拆分 | **是** |
| `query_failed` | 页面异常或查询失败 | **是** |
| `interrupted` | 进程中断（重启后识别） | 需重试 |
| `cancelled` / `failed` | 已取消 / 失败 | 视情况 |

### 硬约束（写自动化时必须遵守）

1. **必须有 `account`**。没有它就 `needs_shop_review`，不点任何东西 —— 这是防串店的第一道闸。
2. **取账全局串行**。多个店铺会排队；同店重复调用直接返回 `{state:'running'}`，不会重复取。
3. **同店/同账期/同账单类型防重复**；`due()` 保证每月 15 日只自动触发一次（已有 job 就不再建）。
4. **"收到文件" ≠ "已入账"**。`received` 只代表文件进了待核对区；真正入账必须 `commit*` 且显式传 `true`。
   当前 IPC 已严格校验 `acknowledged === true`；无界面账本方法仅判断 truthy，严格布尔校验尚需补齐，调用方不得传字符串或数字代替确认。
5. **重复运行不重复入账**：批次内容（解析结果 + 字段映射）与当前版本一致时，`commitBatch` 返回 `{duplicate:true}` 且不新增版本。
6. **多分片不互相覆盖**：同月同类型多个文件属于同一 version 的多个 part，历史版本可整体回溯。
7. **涉税报送账单、资金流水、订单金额口径分开**，不互相推算。
8. **不碰**：付款、店铺设置变更、税务申报提交、缴税。

### 可调环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `FINANCE_EXPORT_TIMEOUT_MS` | 45000 | 点导出后等待下载的超时 |
| `FINANCE_POLL_INTERVAL_MS` | 3000 | 导出中心轮询间隔 |
| `FINANCE_ALLOW_TEST_ORIGIN` | 关 | `1` 时允许打开非淘宝域名（仅测试） |
| `FINANCE_TEST_ORIGIN` | 空 | 允许的测试域名，如 `http://127.0.0.1:8080` |
| `FINANCE_PROBE_SECONDS` | 900 | 真机探针最长等待秒数 |
| `FINANCE_PROBE_OUT` | `%TEMP%\finance-real-probe.json` | 探针结果输出 |
| `FINANCE_PROBE_SHOT` | `%TEMP%\finance-real-probe.png` | 探针截图输出 |
| `FINANCE_PROBE_PROFILE` | `%LOCALAPPDATA%\wucheng-erp-finance-probe` | 探针登录态目录 |

---

## 5. 目录与数据位置

- **财务数据库**：`<Electron userData>/workspace/finance/finance.sqlite`
  默认 userData = `C:\Users\<用户名>\AppData\Roaming\wucheng-ecommerce-erp-v2`，由 `desktop/shared/user-data-path.mjs` 显式指定；传入 `--user-data-dir` 时使用指定目录。
  也可在界面里用「更多 → 打开财务资料目录」直接打开（对应 `finance:folder`）。
- **原始账单文件**：同目录下 `originals/<sha256>.<ext>`（按内容哈希命名，天然去重）。
- **下载临时区**：同目录下 `incoming/`；**未匹配到导出意图的下载**会进 `incoming/unmatched/` 并记为待人工。
- **不写入仓库**：财务原始文件与数据库都在 userData，不在项目目录内。

---

## 6. 现成命令（Codex 可直接跑）

```powershell
npm run test:finance        # 纯逻辑：账本 + 任务 + 页面适配器（不启动 Electron，秒级）
npm run test:finance-ui     # 财务界面冒烟（真实 Electron 窗口）
npm run test:finance-rpa    # 端到端取账（本地仿真平台 + 真实 Electron）
node tests/finance-multi-account.mjs      # 多账号并发登录隔离验证
node tests/finance-real-probe.mjs         # ★真机只读探针（需人工扫码登录一次）
node tests/finance-rpa-debug.mjs          # 单店主流程调试，直接打印每类结果
```

`tests/fixtures/qianniu-server.mjs` 是**本地仿真平台**（登录页 / 账单页 / 历史下载记录 / 异步导出任务），已按 2026-10-10 真机结构对齐：三级账单分类、`月汇总|日汇总|收入明细` 子类型、左侧业务导航、起止两个输入框的月份区间、`导出PDF`+`导出Excel` 双按钮、公告弹窗。

---

## 7. 当前能力边界（**不要过度承诺**）

### 已验证可用

- 仿真端到端：收入 3 个子类型 + 支出 2 个 + 涉税 1 个 = **6 个文件全部取到**，`missing` 全空，含 sha256 与字节数校验；整批入账为多分片版本、无覆盖。
- 多账号并发：两店各写同名 Cookie 后各读回，**互不覆盖**（`tests/finance-multi-account.mjs` 通过）。
- 纯逻辑：`finance-page` 25 项 + `finance-ledger` 13 项全部通过。
- 交接方报告：客户端未发现 `DevToolsActivePort`，主窗口 `Qt5152QWindowIcon` 的 UIA 子元素数为 **0**，遍历曾挂起。这说明所测 CDP/UIA 路径不可用，不能据此断言所有鼠标或图像 RPA 都不可用；本模块目前采用独立 Electron 网页会话。

### 真机已验证 / 未验证

- **已验证（只读）**：登录页→账单页判定、三个账单分类自动识别（`收入账单/支出账单/涉税信息报送账单`）、页面自述 `限制：50000 条`、`共 1 项` 记录数解析。
- **未验证**：**从未点击过导出**。真实文件的格式、字段、命名、"导出Excel"是同步下载还是进「历史下载记录」，全部**尚未验证**。
  → 因此当前状态是 **「未通过真实下载验收」**。
- 已知真机结构特征（已按此改码）：月份是**起止两个输入框**的区间组件；子类型是 `月汇总/日汇总/收入明细`；导出按钮有 `导出PDF` 与 `导出Excel` 两个（只取 Excel）；页面有公告弹窗与消息浮层需先关闭；超限时平台提示"建议缩小查询时间范围后再导出"。

### 待办

以下属于能力待验收清单，不是绕过访问限制的执行授权。当前工具对千牛相关页面存在安全拦截，不得改用 IPC、RPA、其他 AI 或其他访问方式绕过；真实平台验证须在允许的环境和访问路径下进行。

1. 真机点一次 `导出Excel`，确认下载方式与文件结构（登录态仍保留在探针目录，不用重新扫码）。
2. 支出/涉税页面的子类型用探针再采一次确认。
3. 超限（>50000 条）自动分片**未实现**：目前只输出按天的连续区间清单并转人工。
4. 核对月汇总、日汇总、收入明细是否为同一业务的不同视图。仿真中的 6 文件/12 行不证明真实文件可相加；未经核对不得照搬仿真入账方式。
5. 完整 E2E 等待最终结果后再判定通过。当前脚本店铺甲期望 6 文件，但店铺乙仍期望 4 文件；仿真 `SUBTYPES` 已统一为 3+2+1，需核对该断言是否已过时。仅把等待时间改为 15 分钟不能证明整套测试没有其他失败。

---

## 8. 排错速查

| 现象 | 原因 / 处理 |
|---|---|
| `needs_shop_review` 且提示"未配置后台可见账号" | 店铺的 `account` 为空 → 去店铺设置填上账单页顶部显示的账号文字 |
| `needs_shop_review` 且提示"页面未出现账号" | 账号填错，或页面还没加载完；人工在窗口里确认店铺后再 `resume` |
| `needs_manual` 提示"多个疑似导出入口" | 页面出现多个 Excel 导出按钮 → 需人工确认，程序不会随便挑 |
| `needs_manual` 提示"账期控件自动填写未生效" | 账期是受控组件，写值被框架还原 → 人工设好账期后 `resume` |
| `needs_manual` 提示"超过页面自述上限" | 见 `job.note.shards` 的按天分片清单 |
| `query_failed` | 页面结构与适配器不符（平台改版）→ 先跑 `probeFinance` 重新采集 |
| 下载文件被判为无效 | 被识别成 HTML 登录页/损坏/未完成 → 会保留在 `incoming/` 并记为待人工，不计入成功 |
| 重复跑后没产生新版本 | 正常：内容一致按重复处理，`commitBatch` 返回 `{duplicate:true}` |
