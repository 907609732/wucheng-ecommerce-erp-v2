# 菜鸟云仓按需扩展

Windows 云仓源码工作区：与 ERP 并排的 `cainiao-inventory-codex/windows/workbench`。远端仓库为 `907609732/cainiao-inventory`；原有 macOS 插件仍保留。默认 `npm run build` 从此目录读取云仓源码，可用 `LINGTU_WAREHOUSE_SOURCE` 指定其他绝对路径。

主包保留模块 `warehouse` 的导航入口、签名目录和安装逻辑，不带云仓代码、云仓依赖或浏览器压缩包。左侧入口在未安装时显示“待安装”；点击后显示版本与完整下载大小，点击“下载并安装”才安装。完成后同一入口打开独立云仓窗口。

安装复用现有冻结签名目录、SHA-256、断点续传、解压与激活机制。后台启动、外部 AI 调用、自动准备都不能触发首次云仓下载。启动时检查激活回执、注册表和实际文件；缺失、损坏或版本不符会显示安装或修复提示。业务数据不属于程序替换目录。

云仓的 Node 适配器和预览账本初始化代码从扩展的 `app.asar.unpacked` 加载。云仓采集子进程也使用展开后的实际路径。Electron 宿主继续共用；没有额外安装第二份 Electron。

## 构建与发布

```powershell
npm.cmd run build
npm.cmd run build:installer
# 在独立仓库收集经过摘要验证的扩展发布文件：
node scripts/build-windows.mjs --from-receipt
```

最后一条在独立仓库执行。扩展与浏览器包发布到独立仓库的 `warehouse-<宿主版本>-<清单摘要>` 标签，其余组件仍沿用 ERP 发布仓库。必须先准备扩展发布，再发布引用它的工作台。当前兼容范围绑定构建宿主的精确版本；没有动态信任第三方或未签名更新。

当前默认构建链仍使用独立预览应用身份和测试账本。旧正式发布入口已停用；本次修改不切换正式安装身份，不迁移正式账本。ERP 原目录中的历史云仓源码暂供旧测试和兼容入口使用，新轻量安装包通过文件检查禁止携带这些源码。

## 验收命令

```powershell
node --test tests/on-demand-components.test.mjs tests/module-manager.test.mjs tests/warehouse-extension-package.test.mjs
node --test tests/business-activated-adapters.test.mjs tests/business-interface-review.test.mjs
node tests/warehouse-extension-ui.mjs
node tests/launcher-ui.mjs
```

测试覆盖首次打开不下载、显式安装、重启识别、损坏检测、断网、取消、重试、数据保留、签名、版本兼容与依赖裁剪。真实菜鸟登录、采集和业务消息发送需要独立记录实际验收结果，不能用测试夹具代替。
