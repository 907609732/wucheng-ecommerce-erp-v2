# Agent 开发预览交付说明

预览从主集成树冻结源码 `50db68d` 准备，使用独立程序身份与 `%LOCALAPPDATA%/WuchengAgentBeta-preview` 配置目录，不迁移正式账本，不包含完整业务服务和采集运行环境。界面显示“开发预览 · 功能未完成 · 未迁移正式账本”。两种公司 AI 引擎均需独立配置和另行验证；此包不可用于正式业务，不发布到正式更新通道。

使用预打包目录实际启动，首页目标输入框和设置页可见，任务中心加载，先前的 `exceljs` 缺包错误消失。尚未验证安装器安装、正式数据、业务服务、引擎执行或完整验收。界面显示的“已连接公司主机”只表示本地测试运行时，不表示正式服务或账本已接入。

`scripts/build-agent-preview.mjs` 可在独立工作区重建：传入冻结源码的绝对路径和固定 Electron 分发目录。构建保留三个模块的生产依赖，将应用放到预打包的 `resources/app`，再用 electron-builder 制作独立 NSIS 安装器。构建输出仅供预览，安装器未签名。

实际安装器：C:\Users\90760\.codex\worktrees\erp-agent-beta\五成电子商务集团ERP-V2\dist\agent-preview-fixed\output-prepack\WuchengAgentPreview-Setup-0.9.2-x64.exe；SHA-256：81f82716ada894039ab3f1dc7ca1d274a39be24d00c4d3c524f0c761538cb6b7；252149049 字节。由于 NSIS 元数据来自构建工作区根包，安装器文件名显示 0.9.2；这只是开发预览安装器标识，不代表正式版本或已验收版本。
