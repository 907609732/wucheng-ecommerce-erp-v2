# 离线安装包运行时去重：阶段①验收与阶段②阻塞

日期：2026-10-31。仅完成并验证浏览器运行包移除；未执行阶段②至⑤，未创建 Git 提交或推送。

## 安装包与组件

| 项目 | 字节 | MiB |
| --- | ---: | ---: |
| 改动前安装器 | 857,557,895 | 817.83 |
| 阶段①安装器 | 661,651,452 | 631.00 |
| 实际减少 | 195,906,443 | 186.83 |

阶段①安装器 SHA-256：`AB6982752BAE364DD3E9C1C7CA6712BA96212BB9F7AEBFE49CE5DD55A3A0EF2D`。
旧浏览器组件 ZIP 为 196,662,674 字节。新签名 catalog 恰有 6 个组件：5 个业务模块及 `node-runtime`，不含 `browser-runtime`。云仓组件版本从 0.9.2 升到 0.9.3，以满足同版本内容不得替换的安装保护。旧签名缓存和历史迁移清理代码仍识别旧浏览器组件，仅用于兼容旧资料；新安装器不携带它。

安装器：`dist/launcher-release/CloudWarehouseInventorySync-Setup-0.11.5-x64.exe`。签名套装：`dist/suite-payload-EOEVxM/`。隔离验收报告：`dist/module-verification/suite-isolated-0.11.5.json`。本轮 4 个临时构建目录已清理，共 1,903,639,436 字节。

## 阶段①改动

- 菜鸟登录和同步通过 Playwright 优先启动系统 Edge，启动失败时回退到系统 Chrome；不再读取 `LINGTU_BROWSER_PATH`。
- 云仓安装配置不再注入 `browserPath`；签名 catalog、安装顺序、打包脚本和组件数量校验改为六组件。
- 同步源码启动台的签名 catalog，更新对应验收测试与当前扩展接口文档。
- 保留五个业务模块、远程访问网关、Tailnet、库存 MCP、独立 `node-runtime` 和云仓独立 Electron 包。

## 已执行验证

- 系统 Edge 有界面启动成功；隔离资料目录访问菜鸟入口，HTTP 200 并跳转到“菜鸟统一登录”。未完成人工账号认证。
- 云仓源码与已打包程序内的 Playwright 同步、持久登录两种 Edge 启动模式均通过。
- `test:core` 27/27、`test:desktop` 35/35、`test:modules` 18/18；浏览器、签名缓存和套装激活定向测试 20/20；`test:launcher` 通过。
- 已打包主程序的 `--cli status` 返回 JSON；`--mcp-stdio` 工具列表测试通过，只有 `inventory_*` 与 `cainiao_refresh_login`，无 `workbench_*`。
- 已打包网关在工作区外隔离目录启动并通过健康与依赖闭包检查；使用现有托管 Node.js 24.18.0，未启动业务模块。
- 六组件在临时资料目录中离线激活，五套合成账本通过完整性检查；四个首页入口、导出台和系统 Edge 可用。卸载采购组件再离线恢复后，五套合成账本及原件保持一致，模块下载次数为零。
- 完整 NSIS 安装器构建成功。尚未实际执行 NSIS 安装，亦未用正式菜鸟账号完成登录；这些不能视为最终用户安装验收。

## 阶段②阻塞

`desktop/workbench-client/gateway-lifecycle.mjs` 在启动网关前明确删除 `ELECTRON_RUN_AS_NODE`，随后执行 `spawn(node, ...)`。如果按阶段②要求把 `node` 改为 `process.execPath`，网关子进程不会进入 Electron 的 Node 模式。该文件属于本任务禁止修改的 `desktop/workbench-client/**`；保留独立 Node 又无法达到五组件目标。按“阶段卡住就停”要求，没有实施阶段②至⑤，也没有将六组件中间安装器安装到正式环境。

继续阶段②需要明确允许对该网关启动文件做最小的环境变量处理修改，并重新进行隔离网关、五模块、安装器和实际安装验收。当前 400–550 MB 目标尚未达到。
