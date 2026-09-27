# 菜鸟云仓 SKU 月销量趋势与月报

## 统计口径

- 销量（件）仅等于菜鸟库存明细中的 `toC销售出 + toB销售出`。
- 调拨、盘亏、加工等其他出库不计入销量，不展示或估算销售金额。
- 只有来源日期完整覆盖自然月、必要列齐全、SKU 唯一且销量非负的数据才进入正式表。
- 缺失月份返回 `null`，页面显示“无数据”，不会补 0 或插值。

正式数据存放在 `warehouse_monthly_sales`；校验记录存放在
`warehouse_monthly_sales_validations`。它们与每日库存快照及旧的
`monthly_outbound` 完全隔离。

## 三个运行入口

单月抓取、校验和本地导入：

```powershell
npm.cmd run sync:sales:monthly -- --month 2026-08
```

也可以用已经下载的完整月文件做受控导入：

```powershell
npm.cmd run sync:sales:monthly -- --month 2026-05 --file "downloads\完整月文件.xlsx"
```

单月抓取、同步云端并发送一次月报：

```powershell
npm.cmd run sync:sales:monthly:cloud -- --month 2026-08
```

历史 12 个月补抓（2025-08 至 2026-07）：

```powershell
npm.cmd run sync:sales:backfill
```

历史补抓逐月最多导出一次；任何登录、验证码、滑块、下载或校验错误都会立即停止。
再次运行会跳过已验证月份，从失败月份继续。全部月份验证后只上传一次数据库快照，
并显式跳过历史钉钉消息。

## API 与网站

`GET /api/reports/warehouse-monthly-sales` 支持：

- `from=YYYY-MM`
- `to=YYYY-MM`
- `warehouseId=cainiao`
- `sku=SKU或商品名`

经营看板中的“菜鸟云仓 SKU 月销量趋势”使用本地 npm 依赖 Chart.js 4。
有效完整月份少于 8 个时使用柱状图；达到 8 个后切换折线图。页面同时提供
KPI、总量趋势、Top 5 趋势、单 SKU、月度排名和 SKU × 月份明细表。

## 钉钉与防重

月报只走现有云端企业应用机器人，并使用 `userIds` 和正文 `@用户ID` 真实提醒目标用户。
`monthly_report_deliveries` 以“报告类型 + 月份”唯一防重：

- `sent`：明确成功，之后跳过。
- `unknown`：网络超时等未知状态，之后不自动重发。
- `pending`：已有发送中的实例，之后跳过。
- `failed`：钉钉明确拒绝，可在修复配置后人工重试。

预览不会创建投递台账，也不会发送真实消息：

```powershell
$body = @{ type = "warehouse-monthly"; month = "2026-08"; dryRun = $true } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3000/api/dingtalk/send-report -Method Post -ContentType application/json -Body $body
```

网站链接由 `ERP_PUBLIC_URL` 配置。正式月度任务每月 5 日 09:00（Asia/Shanghai）
运行上一完整月；现有每日 22:00 库存任务不做任何修改。
