# 本机 HTTP 接口参考

[返回项目首页](../README.md) · [使用指南](USAGE.md) · [数据与备份](DATA.md)

接口供本机页面和受控工具调用。以下以 `http://127.0.0.1:17869` 为例，实际端口以服务输出或 `data/server.port` 为准。路由实现以 [server.mjs](../server.mjs) 为准。

## 约定

- 读取接口使用 `GET`；写操作使用对应 `POST`、`PUT` 或 `DELETE`。
- JSON 响应中的货币金额通常为**最小货币单位整数**，人民币为分；Excel 和页面显示为元。
- 录入金额的 JSON / 表单字段通常使用元；拼多多截图对照的金额表单也使用元，服务端转为分。不要把响应里的分直接原样写回录入金额。
- 未取得金额可能为 `null`，不能直接解释为 `0`。
- 店铺 ID 从 `/api/bootstrap` 获取。平台专用接口必须使用该平台的店铺 ID。
- 日期格式为 `YYYY-MM-DD`，月份为 `YYYY-MM`，年份为 `YYYY`。
- 错误通常返回 `{ "error": "说明", "code": "错误代码" }`。常见状态包括 400 参数错误、403 会话或访问限制、404 不存在、409 业务冲突、423 月份锁定；并非所有接口都返回同一错误代码。

## 会话与写入保护

```powershell
$base = 'http://127.0.0.1:17869'
Invoke-RestMethod "$base/api/health"
$webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session = Invoke-RestMethod "$base/api/bootstrap" -WebSession $webSession
$headers = @{ 'x-sales-token' = $session.token }
Invoke-RestMethod "$base/api/personnel/session" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"role":"boss"}' -WebSession $webSession
```

后续业务请求携带 `-WebSession $webSession` 保持已选身份，写请求同时携带 `$headers`。JSON 写入设置 `Content-Type: application/json`；上传原件使用 `multipart/form-data`。

服务重启会更换令牌，需要重新读取 bootstrap。令牌只用于本机会话，不应保存到代码或日志，也不提供多用户授权能力。

页面必须选择老板或员工身份后才能读取业务数据。人员身份使用服务端会话和 HttpOnly cookie；员工不能读取或修改资金核对、月报、锁定和导出接口。远程已授权的员工不能通过身份选择获得老板权限。本机受控 CLI/MCP 保持原有鉴权方式。

## 人员与月度交接

| 方法 | 路径 | 用途 / 主要参数 |
| --- | --- | --- |
| GET | `/api/personnel/session` | 是否需要选择身份、当前 `role` 和能力范围 |
| POST | `/api/personnel/session` | `{role:"employee"}` 或 `{role:"boss"}`，替换当前页面人员会话 |
| GET | `/api/task-center?month=YYYY-MM` | 按身份返回本月任务摘要；员工不返回老板资金和月报数据 |
| POST | `/api/personnel/handoff` | 员工以 `{month,revision}` 提交资料；revision 使用任务摘要的 `staffRevision` |
| GET | `/api/manual-summary?month=YYYY-MM&shop=all` | 员工可读的线下和代发店铺摘要，保留跨月应收余额 |

`submission.state` 为 `draft`、`submitted` 或 `changed`。资料齐全且月份未锁定时才能提交；员工资料变更后需要重新提交，老板正常核对资金不会使交接失效。

## 基础与通用报表

| 方法 | 路径 | 用途 / 主要参数 |
| --- | --- | --- |
| GET | `/api/health` | 本机服务状态与版本 |
| GET | `/api/bootstrap` | 会话令牌、店铺、字段、当前默认月份、计划状态及 `pendingEdits`（全部待确认修改数，不含已完成） |
| GET | `/api/report` | `period`、`grain=day/month/year`、`shop=all/店铺ID` |
| GET | `/api/export` | 通用 Excel，使用与报表相同的期间、粒度和店铺参数 |
| GET | `/api/sources` | `month`，渠道状态及数据覆盖；自动访问状态不等于手工导入状态 |
| GET | `/api/template/:type` | `operations` 或 `ledger` 通用 CSV 字段模板 |

`GET /api/report` 可使用 `empty_trend=skip`：无支付销售额时跳过空销售趋势的重复计算，有真实销售额时保留正常趋势。它不改变资金账单的金额口径。

## 拼多多与淘宝资金接口

以下前缀分别为 `/api/pdd`、`/api/taobao`；两类账单的日期依据及覆盖能力不同，见数据文档。

| 方法 | 路径 | 参数 / 结果 |
| --- | --- | --- |
| GET | `/{平台}/funds` | `shop_id`、`period`、`grain=day/month/year`；收支、分类与趋势 |
| GET | `/{平台}/statement` | `shop_id`、`year`；年度按月数据及覆盖信息 |
| GET | `/{平台}/movements` | 筛选后总数、收支合计、分页行和筛选选项 |
| GET | `/{平台}/movements/:id` | 当前店铺范围内的单笔原始信息 |
| GET | `/{平台}/movements-export` | 全部筛选结果 Excel，不只导出当前页 |

这里 `/{平台}` 指完整前缀，例如 `/api/pdd`，不是字面量路由。

### 明细查询参数

| 参数 | 含义 |
| --- | --- |
| `shop_id` | 必需，平台对应店铺 |
| `month` | 月份；可用 `from` / `to` 指定日期范围 |
| `from`、`to` | 起止日期，包含边界；覆盖相应月界限 |
| `q` | 订单号的部分或完整文本；淘宝同时搜索子订单 |
| `direction` | `income` 或 `expense`；省略表示全部 |
| `category` | 显示分类名，例如「交易收入」「退款」 |
| `batch_id` | 来源批次 ID |
| `page` | 从 1 开始 |
| `page_size` | 50 或 100，默认 50 |
| `sort` | `occurred_at`、`amount`、`order_no` 或 `category` |
| `sort_dir` | `asc` / `desc`，默认降序 |

示例（将 ID 替换为已确认店铺）：

```text
GET /api/taobao/movements?shop_id=<shop-id>&month=2026-09&direction=income&page=1&page_size=50
GET /api/pdd/movements-export?shop_id=<shop-id>&month=2026-09&category=退款
```

列表的 `total` 和 `totals` 对应全部筛选结果，`rows` 只包含当前页。单笔原件可通过返回的 `batch_id` 在 `/api/imports/:id/original` 下载。

### 拼多多待归属与截图

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/pdd/unassigned` | 待确认批次 |
| POST | `/api/imports/:id/attribution` | `status`、`shop_id`、`reason`；归属调整前备份并检查锁定 / 重复 |
| POST | `/api/pdd/shops` | `name`，登记新拼多多店铺 |
| POST | `/api/pdd/references` | multipart：店铺、月份、截至日期、收入 / 支出、笔数、余额及可选截图 |
| GET | `/api/pdd/references/:id/evidence` | 对照截图 |

待归属明细通过拼多多明细接口显式指定 `attribution=unassigned&batch_id=...`；不进入正式店铺汇总。

## 导入生命周期

| 类型 | 读取 / 暂存 | 预览 | 提交 |
| --- | --- | --- | --- |
| 拼多多 ZIP | `POST /api/pdd/import`，multipart `shop_id`、`file` | `GET /api/pdd/import/:id` | `POST /api/pdd/import/:id/commit` |
| 淘宝交易货款 CSV | `POST /api/taobao/import`，multipart `shop_id`、`file`；返回预览 | 使用读取响应中的预览信息 | `POST /api/taobao/import/:id/commit` |
| 通用表格 | `POST /api/imports`，multipart `shop_id`、`month`、`dataset`、`file` | `POST /api/imports/:id/preview`，字段映射与来源定义 | `POST /api/imports/:id/commit` |

提交 JSON 必须携带预览返回的 `revision`。有冲突、锁定、待归属或过期预览时，按接口结果处理，不能跳过预览直接写账。

通用 `dataset` 为 `operations` 或 `ledger`。上传限制 25 MB；通用导入可指定 `sheet` 和 `header_row`。

其他导入相关接口：

- `GET /api/imports`：最近批次及其状态。
- `GET /api/imports/:id/original`：下载保留的原件。
- `POST /api/imports/:id/rollback`：填写 `reason` 撤销批次；有匹配或锁定需先处理。
- `GET /api/report-history`：保留的历史报告标记。

## 运费接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/freight/report` | 合计、分类型、归属、趋势及月汇总未分配提示 |
| GET | `/api/freight/records` | 分页记录，默认排除作废 |
| GET | `/api/freight/records/:id` | 明细、当前凭证及历史凭证 |
| POST | `/api/freight/records` | 新增，JSON 或 multipart |
| PUT | `/api/freight/records/:id` | 编辑，JSON 或 multipart，必须提供当前 `version` |
| POST | `/api/freight/records/:id/void` | `reason`、`version`、`request_id`，作废并留存原件 |
| GET | `/api/freight/attachments/:id` | 图片／PDF 查看，表格下载；`download=1` 强制下载 |
| GET | `/api/freight/export` | 全部筛选结果 Excel |

查询参数统一为 `period`、`grain=day|month|year`（默认 month）、`shop=all|shared|店铺ID`、`channel=all|warehouse|merchant|sf`。明细及导出可带 `status=all` 包含作废记录，作废费用始终不参与汇总。列表 `page` 从 1 开始，`page_size` 为 25／50／100，默认 25。

写入字段：`channel`、`entry_mode=month|day|single`、`period`、`shop_id`（共用可空或 shared）、`shipping`（必填）、可选 `packing/materials/storage/other/other_note/pieces/bill_no/tracking_no/note`。金额入参为元，最多两位小数；响应金额为整数分。仅云仓可写附加费用，`other>0` 必须有用途说明。附件为 multipart 的 `files` 数组；编辑可通过 JSON 数组或其字符串形式的 `remove_attachments` 移除现有附件引用，原件仍留存。

所有写入必须携带稳定的唯一 `request_id`，同一次网络重试复用原编号；不同内容不能复用已成功编号。编辑和作废使用 `version` 防止覆盖其他修改。疑似重复返回 HTTP 409、`code=FREIGHT_REVIEW` 及 `details.conflicts/review_token`；人工确认未重复后，携带相同内容和返回的 `review_token` 重试。内容或已有记录变化会重新要求核对。此确认不能绕过月份锁定。

每笔有效附件最多 5 个、单个 25 MB、合计 50 MB。类型为 PNG/JPG/WebP/PDF/XLS/XLSX/CSV，表格只留存，不解析入账。

## 月报、锁定与备份

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/close?month=YYYY-MM` | 月份确认预览和 revision |
| POST | `/api/close/lock` | `month`、`revision`、`confirmation="锁定 YYYY-MM"` |
| POST | `/api/close/unlock` | `month`、`reason`、`confirmation="解锁 YYYY-MM"` |
| GET | `/api/close/history` | 月份历史 |
| GET | `/api/audit` | 最近审计记录 |
| POST | `/api/jobs` | `period=YYYY-MM`，生成已保存数据的月报草稿 |
| GET | `/api/jobs` | 月报任务历史 |
| GET | `/api/jobs/:id/report` | 下载已生成报告 |
| GET / POST | `/api/backups` | 列出 / 创建备份 |
| POST | `/api/backups/:name/verify` | 校验文件哈希及 SQLite 完整性 |
| POST | `/api/backups/:name/restore-copy` | 恢复到独立目录，不覆盖当前账本 |

接口调用成功或月报文件生成不代表平台后台已执行采集；完整性与真实业务验收另行核对。
