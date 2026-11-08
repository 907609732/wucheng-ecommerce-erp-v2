# 开发版控制台与日志

出问题时先看控制台窗口和日志文件，不需要再去翻浏览器控制台。

## 日志在哪

| 位置 | 内容 |
|---|---|
| 控制台窗口（双击 `打开ERP开发版.bat`） | 实时滚动：ERROR 红色、WARN 黄色、INFO 灰色；窗口标题会显示最近一条错误 |
| `<配置文件所在目录>/logs/web.log` | 完整历史，单个文件 5 MB 轮转，保留 5 份（`web.log.1` … `web.log.5`） |
| `<配置目录>/stdout.log`、`stderr.log` | 进程级输出（Node 崩溃、模块自身打印），控制台同样会显示 |

开发版是 `E:\WuchengERP\development\logs\web.log`；正式版是 `E:\WuchengERP\logs\web.log`。

## 日志级别

- **info**（默认）：错误、告警、慢请求（≥1.5 秒）、模块连接/恢复、维护与启停、每分钟一次请求统计。正常浏览不会刷屏。
- **debug**：每个请求一行，带状态码、耗时和 requestId，用于逐条追查。

开启 debug 的方式（任选一种）：

1. 双击桌面 `打开ERP开发版-调试.bat`；
2. `powershell -File server\windows\dev-console.ps1 -Debug`；
3. 设置环境变量 `ERP_LOG_LEVEL=debug` 后启动；
4. 临时调低噪音：`node server/cli.mjs dev --config <配置文件> --log-level warn`。

## 一行日志怎么读

```
2026-11-05 01:38:48.901 INFO  host:gateway   模块就绪较慢 {"module":"purchase","pid":14284,"ms":1346,"requestId":"req-2"}
```

- 结构：`时间 级别 作用域 消息 {字段}`，整条单行，方便 grep。
- 作用域：`host`（主机与维护）、`host:gateway`（请求与代理）、`host:modules`（业务台进程）。
- 常用字段：`requestId`（与接口响应体里的 requestId 一致）、`status`、`ms`、`module`、`code`、`phase`、`target`。
- 消息里的换行会被压平，异常信息截断到 400 字，避免刷屏。

## 排查对照

| 现象 | 先搜 |
|---|---|
| 浏览器提示“页面资源加载失败，业务台尚未启动” | `ERROR host:gateway`、`模块 .* 未就绪`、`写入进程归属记录失败` |
| 打开某个业务台一直转圈 | `模块 .* 未就绪：`、`模块按需启动` 的耗时 |
| 页面很慢 | `慢请求`、`模块就绪较慢`、`最近一分钟请求` |
| 服务自己停了或重启 | `网页服务正在停止`、`维护窗口`、`模块无响应` |

例如“来回切换就报错”的那次问题，日志里是这样两条相邻记录：

```
ERROR host:modules   写入进程归属记录失败：EPERM: operation not permitted, rename ... {"code":"EPERM","file":"...web-ownership.json"}
ERROR host:gateway   模块 purchase 未就绪：EPERM: ... {"phase":"ensure","target":"/apps/purchase/app.js"}
```

## 不影响业务

- 写日志文件失败会被忽略，不会让请求或服务失败。
- 网关只记录路径、状态码、耗时和模块名，不记录请求体、Cookie 或账本内容。

## 维护提示

- `server/windows/dev-console.ps1` 含中文，必须保存为 **UTF-8 with BOM**，否则 Windows PowerShell 5.1 会解析失败。
- 日志跟随逻辑在 `server/windows/console-logs.ps1`（纯 ASCII），改它不涉及编码问题。
- 日志实现是 `server/log.mjs`；网关、模块管理、运行时启动都通过 `createLogger()` 接入。
