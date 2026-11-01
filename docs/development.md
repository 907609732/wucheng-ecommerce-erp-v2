# 开发与构建

当前主线为五模块轻量业务预览版，安装身份和正式账本隔离。Node.js 24、npm、GitHub CLI、Gitleaks 和锁定 Electron 是本机工具环境；业务依赖按各自锁文件安装，不做全局 npm 业务依赖安装。

日常修改使用源码启动和相关验收，不默认执行构建、打包或安装。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd ci --prefix apps/exporter --ignore-scripts
node apps/exporter/node_modules/electron/install.js
npm.cmd run dev
npm.cmd run build
npm.cmd run verify:quick
npm.cmd run verify:integration
npm.cmd run build:installer
npm.cmd run verify:release
```

`dev` 直接启动源码 Electron 工作台与采购、销售、经营服务，并可从侧栏打开独立云仓源码窗口，使用临时合成测试账本，不接入正式账本或登录资料。这是源码开发夹具，尚不等同于五模块安装验收。构建、安装和组件下载仅在对应专项验收或明确需要安装包时执行。`build` 准备可审计的隔离资源目录，不隐含安装或发布。首次构建仍需安装依赖及构建五模块；后续由 Turborepo 复用未变化任务。

任务分为 host 生产依赖、五个模块构建、资源组装、公共载荷扫描、签名目录及 NSIS 安装器。并发默认 2。任务缓存覆盖源码、相关锁文件、配置及系统/架构/Node/Electron 版本；根锁文件变动可能扩大失效范围。缓存命中不代替安装验收。

`build:installer` 使用最近一次与当前源码完全匹配的成功构建，重新扫描、签名和压缩。签名私钥使用仓库外现有位置或 `LINGTU_MODULE_SIGNING_KEY`；不得复制到源码或日志。输出及报告在 `.codex-artifacts/engineering`。扫描器复用已锁定的现有 Gitleaks 审查流程，出现未知发现时停止。

默认压缩档 1；可设置 `ERP_COMPRESSION_LEVEL` 为 1–9 做独立测量，不能把最高压缩设为日常提速方案。最终安装器大小和耗时以实测报告为准。

`launcher:build`、`desktop:build`、`workbench:build` 转发到新安装器入口；`desktop:pack` 转发资源构建。旧完整离线构建入口已停用，旧脚本保留只供历史追溯，不能作为新版本发布路径。

修改公共 Loading 后运行 `node scripts/sync-loading-assets.mjs`。架构模块表由 `npm.cmd run docs:architecture` 生成；云仓功能说明由 `npm.cmd run docs:features` 生成。不要编辑生成表格再另存一套清单。
