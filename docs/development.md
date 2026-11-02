# 开发与构建

日常主线为采购、销售、经营总览的浏览器服务，开发数据与正式账本隔离。需要系统 Node.js 24 与 npm；浏览器运行路径不需要 Electron。业务依赖按各自锁文件安装，不做全局 npm 业务依赖安装。详细配置、备份与免安装包更新见 [浏览器运维说明](browser-service.md)。

日常修改使用源码启动和相关验收，不默认执行构建、打包或安装。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd ci --prefix apps/purchase --ignore-scripts
npm.cmd ci --prefix apps/sales --ignore-scripts
npm.cmd ci --prefix apps/overview --ignore-scripts
npm.cmd run dev
npm.cmd run web:check
npm.cmd run web:status
```

`dev` 启动本机浏览器开发服务，默认 http://127.0.0.1:28430，使用 `.codex-artifacts/web-dev` 隔离数据。修改页面后刷新，修改已启动模块的后端后自动重启；主服务源码修改后手动重启开发命令。

以下为保留的桌面兼容流程，不属于浏览器日常更新路径。`desktop:dev` 直接启动源码 Electron 工作台与采购、销售、经营服务，并可从侧栏打开独立云仓源码窗口，使用临时合成测试账本，不接入正式账本或登录资料。这是源码开发夹具，尚不等同于五模块安装验收。构建、安装和组件下载仅在对应专项验收或明确需要安装包时执行。`build` 准备可审计的隔离资源目录，不隐含安装或发布。首次构建仍需安装依赖及构建五模块；后续由 Turborepo 复用未变化任务。

任务分为 host 生产依赖、五个模块构建、资源组装、公共载荷扫描、签名目录及 NSIS 安装器。并发默认 2。任务缓存覆盖源码、相关锁文件、配置及系统/架构/Node/Electron 版本；根锁文件变动可能扩大失效范围。缓存命中不代替安装验收。

`build:installer` 使用最近一次与当前源码完全匹配的成功构建，重新扫描、签名和压缩。签名私钥使用仓库外现有位置或 `LINGTU_MODULE_SIGNING_KEY`；不得复制到源码或日志。输出及报告在 `.codex-artifacts/engineering`。扫描器复用已锁定的现有 Gitleaks 审查流程，出现未知发现时停止。

默认压缩档 1；可设置 `ERP_COMPRESSION_LEVEL` 为 1–9 做独立测量，不能把最高压缩设为日常提速方案。最终安装器大小和耗时以实测报告为准。

`launcher:build`、`desktop:build`、`workbench:build` 转发到新安装器入口；`desktop:pack` 转发资源构建。旧完整离线构建入口已停用，旧脚本保留只供历史追溯，不能作为新版本发布路径。

修改公共 Loading 后运行 `node scripts/sync-loading-assets.mjs`。架构模块表由 `npm.cmd run docs:architecture` 生成；云仓功能说明由 `npm.cmd run docs:features` 生成。不要编辑生成表格再另存一套清单。
