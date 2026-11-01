# Loading 界面统一

2026-10-27。按用户提供的参考图统一本ERP的等待界面：极浅冷白至浅粉背景、居中原品牌图标、蓝色名称、细蓝白珊瑚渐变进度条、真实状态及底部提示。沿用现有品牌，不使用参考图中的其他产品名称或图标。

## 覆盖范围

- 工作台首次启动与升级准备窗；默认960×600，可缩放，480×260历史夹具仍兼容。
- 云仓、采购、销售、总览及采购内导出台的模块打开等待。
- 采购初次打开、设置与任务读取、销售初次读取/身份切换/月度读取、总览初次与刷新。
- 独立云仓首次配置读取、远端云仓首次连接、桌面Vue导出台首次读取、远端导出台首次连接。
- 三个Web模块的手机与辅助页面统一引入轻量适配；既有等待占位、忙碌按钮与原生下载/OCR进度沿用同一视觉。

完整启动采用full模式，模块内容采用content模式，局部读取采用inline模式。业务采集日志、登录验证码、暂停/停止操作和图像资源占位继续由原业务组件管理，不改成阻断全页的启动画面。

## 实现与维护

共享源在 `desktop/shared/loading-screen.css`、`loading-screen.mjs`、`loading-screen-auto.mjs`。标记函数只输出已转义的展示内容；自动适配仅处理明确的等待占位，不将含按钮或错误内容的节点重新包装。原业务代码继续拥有数据请求、进度、确认和错误处理。

`node scripts/sync-loading-assets.mjs` 将资源复制至采购、销售、总览的public目录及导出台自身源码，保障独立模块可打包。远端页面复用已有白名单app.css/app.js端点，嵌入相同样式及原品牌图标，不增加任意资源访问。完整套装构建在指纹计算前自动同步；只读vendor校验不执行同步。

不确定进度的原生progress不设置value，不增加伪百分比或固定展示延迟；已有OCR/下载进度值不改。成功/失败按原逻辑结束，远端会话失败也移除覆盖层，使错误可见。减少动态偏好下停止持续动画。工作台原启动去重、等待秒数、身份隔离及所有入账确认保持原机制。

实施前已检索成熟方案，参考 [Microsoft Fluent UI ProgressBar 规范](https://github.com/microsoft/fluentui/blob/master/packages/react-components/react-progress/library/docs/Spec.md) 的定量、不定量和减少动态行为；本工程沿用原生progress与现有前端体系，兼容离线和Electron CSP。

## 本轮验证

- `node tests/launcher-preparation.mjs`：真实隔离Electron准备窗、IPC阶段更新、窄preload、不定量progress通过。
- `node tests/launcher-loading.mjs`：模块打开、重复点击拦截、等待秒数、失败回退与错误提示通过。
- `node tests/loading-style-ui.mjs`：1280×720、900×650、480×260、360×640无横向溢出；减少动态、动态占位、身份变化、错误重试、真实progress值、按钮恢复、两个远端会话失败释放、资源同步和转义通过。
- `node tests/warehouse-direct-entry.mjs`：云仓直接入口、初始化失败后业务页面及设置可用、无脚本异常通过。
- 远端库存显示3项、采购任务/网关7项、销售任务/导航/对账25项、总览API/看板6项定向回归通过。
- 导出台 `npm.cmd run build` 的TypeScript检查、主进程、preload与Vue生产构建通过。首次发现其开发依赖缺失，按已有锁文件执行npm ci，没有修改锁文件或引入新框架。
- UI智能体复核完整屏与480×260截图通过。ego本地浏览器打开真实准备页完成结构检查，保留该预览页供查看；未升级浏览器。

截图、角色交接与UI验证JSON位于 `.codex-artifacts/loading-style-20261027/`。首次运行的远端库存VM测试夹具缺少DOM的remove方法，已补齐夹具并重跑3项通过；没有为测试改变业务行为。

完整套装打包结果另见该目录的 `delivery.md`。源码/隔离验证不等于当前运行安装版已经替换；未执行真实平台采集、消息发送、OCR业务入账或账本迁移。所有业务账本与现有运行服务保持原状。
