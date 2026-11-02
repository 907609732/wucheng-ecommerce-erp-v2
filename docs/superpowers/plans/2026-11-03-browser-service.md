# ERP 浏览器服务实施记录

目标：采购、销售、经营总览脱离 Electron 日常启动和安装器，复用业务与 SQLite，通过 Tailscale 私有 HTTPS 访问。

- [x] 配置、环境审计与隔离数据基线。
- [x] 三业务服务生命周期、网关、浏览器入口与开发刷新。
- [x] 版本目录、备份恢复、更新回退、Windows 服务配置。
- [x] 性能对比、集成验收、文档与独立审查。

实施约束：不自动接入正式账本，不改云仓与导出，不清理历史文件，不发布安装包。

初始证据：主工作区 HEAD a995314，Git 无未提交改动；Node v24.18.0；系统已安装 Tailscale/Plastic SCM。现有网关与生命周期 27 项基线测试通过。正式位置由 workbench-location.json 绑定到 Documents/LingtuWorkbench/registry.json，三模块均有 backups 目录。Tailscale 状态 NoState，无 Serve 配置。Plastic SCM 状态查询长时间未返回，已终止本次查询进程，未更改 Plastic 状态。

Ruling：原生工作树工具已创建检出，但忽略文件扫描长时间未完成，终止扫描后注册失败，重挂亦失败。继续使用已核实的干净 linked worktree 与 codex/erp-browser-service 分支，始终显式指定绝对目录；主工作区保持原样。

Ruling：仓库当前提交缺少导航所称的 ui/README.md 和共享 UI 同步脚本。首期入口采用现有 desktop/shared/ui 样式，不恢复或改写其他任务未合入的资源。

实施结果：117 项网页/网关/生命周期/经营回归与 31 项销售/菜鸟回归通过；正式数据只读快照 526 文件并恢复验证；独立候选 04→05 与 05→06 更新演练通过。主服务不预加载业务库，静态资源私有重验证，业务接口不缓存。真实平台与双机验收未执行，正式入口未切换。

Final review：独立 reviewer 提出三项 Important：在途启动与停机竞态、宿主崩溃后子进程恢复、仅网关健康检查。三项均通过复现测试 RED→GREEN 修复，并通过回归；未搁置其他审查项。

补充实测：WinSW 2.12.0 不支持 v3 文档中的任意 XML 参数形式，已改为同名 exe/XML 配对，实际 status 解析由失败转为 NonExistent。尚未注册 Windows 服务。

正式切换前剩余：Tailscale 恢复连接、真实双机 HTTPS/文件操作、Windows 开机恢复、用户会话助手真实采集，以及外部备份。详细数据与范围见 docs/browser-validation-2026-11-03.md。
