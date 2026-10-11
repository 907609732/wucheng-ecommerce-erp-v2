# 财务模块测试报告（2026-10-11，北京时间）

本轮只运行本地合成数据、仿真 HTTP 站和隔离 Electron userData；未访问真实千牛、未使用真实店铺账单、未提交税务申报。没有修改业务实现或发布安装包。

## 测试结果

| 项目 | 结果 | 验证范围 |
|---|---|---|
| 财务纯逻辑回归 | 42/42 通过，约20秒 | 账本、worker并发、页面决策、本地接收 |
| 财务 Electron 界面 | 通过 | 建店、导入、预览、人工确认入口、筛选排序、草稿、Excel导出、重启、主页切换 |
| 多账号隔离 | 通过 | 两个店铺会话写入同名 Cookie 后仍各读各的值；不证明真实平台可同时导出 |
| 仿真取账 E2E | 失败 | 首轮收入3文件、支出2文件收到；涉税异步导出中心等待超时，任务进入 needs_review |
| 真实平台下载 | 未运行，未验收 | 现有工具访问限制仍有效，未尝试其他方式绕过 |

E2E 在 `tests/finance-rpa-smoke.mjs:112` 的首轮任务状态断言失败，因此本轮尚未到达重复取账入账、空账单、防串店、第二家店铺完整取账等后续断言。不能用其他单项测试通过替代这些后续验收。

## 已复现的卡点

### 1. 涉税历史下载记录定位歧义（阻断当前流程）

实际 E2E 返回：`涉税信息报送账单：needs_manual（导出中心等待超时，请人工确认导出结果后继续）`。合成数据库保留5个文件，收入/支出批次 complete，涉税未完成。

独立本地复现生成两条已完成的同账期涉税任务，再执行现有页面扫描和动作脚本。结果：两行都被解析，但下载定位均为 `body > table > tbody > tr > td > a`，动作返回 `ok:false, reason:ambiguous, total:2`。

当前异步导出先等待同步下载并重试一次，可能生成重复任务；导出中心对点击失败重复轮询，最终报超时。外层等待已经是15分钟，延长它不能消除按钮歧义。

复现：`node .codex-artifacts/finance-export-center-diagnostic.mjs`（仅 localhost）。修复验收需要覆盖两条以上历史任务、同月不同类型、重复任务与生成中任务，要求匹配到当前任务唯一文件；不得简单改为“点击第一个”。当前按月份回退匹配也未绑定任务ID，属于待加强项。

### 2. 无界面入账 API 未严格要求布尔 true

`FinanceLedger.commit` 和 `commitBatch` 使用 `if (!acknowledged)`。临时合成账本实测传入字符串 `"false"` 均能成功提交。IPC层已有 `acknowledged === true` 校验，但无界面 financeJob 路径没有该层保护。

修复验收应确认字符串、数字、对象等确认值全部拒绝，只有布尔 true 可以提交；拒绝后版本和金额不得变化。

### 3. 不同汇总视图可能重复相加

用两份内容不同、均描述同一笔100元的合成文件，分别标为月汇总/日汇总，整批预览实际返回 `gross:20000` 分、`parts:2`、`issues:[]`。

这说明现有检查能阻止“全部+子类型”，但没有判断月汇总/日汇总/收入明细之间是否覆盖同一业务。真实文件尚未确认，不能直接照仿真把3种视图相加。应在确认账单结构后明确一份入账口径，其他视图用作核对凭证，或证明文件业务范围互斥再合并。

卡点2、3复现：`node .codex-artifacts/finance-ledger-diagnostic.mjs`，仅创建并删除临时合成账本。

## 其他未闭环项

- 店铺乙仍断言4文件，而仿真统一子类型为3+2+1，后续完整测试可能再次在此失败；本轮尚未运行到该断言。
- 超过50000条的自动分片未完成，仅提出拆分区间并转人工。
- 每月15日仍依赖应用运行，未验收关机、休眠、锁屏后的无人值守任务。
- 真实文件格式、导出方式、字段映射、业务口径与跨月完整性未验收。

## 本轮命令及证据

```powershell
node --test --test-timeout=60000 tests/finance-ledger.test.mjs tests/finance-jobs.test.mjs tests/finance-page.test.mjs tests/finance-local-receipt.test.mjs
node tests/finance-ui-smoke.mjs
node tests/finance-multi-account.mjs
node tests/finance-rpa-smoke.mjs
node .codex-artifacts/finance-export-center-diagnostic.mjs
node .codex-artifacts/finance-ledger-diagnostic.mjs
```

环境：Node v24.18.0；项目内 Electron 可用。UI截图在 `dist/finance-verification/`，已查看本轮 `finance-bills.png`；合成导出文件经ExcelJS重新读取并核验金额，重启后草稿仍保留。

本轮E2E隔离数据：`C:\Users\90760\AppData\Local\Temp\erp-finance-rpa-yetRd5\workspace\finance\finance.sqlite`。诊断脚本与报告是本轮新增文件；没有修改或覆盖用户已有财务数据。
