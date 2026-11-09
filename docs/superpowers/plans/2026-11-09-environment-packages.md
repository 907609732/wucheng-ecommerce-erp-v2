# 同源三平台环境包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 一次构建输出同版本、同提交的 Windows、Linux、飞牛独立环境包。

**Architecture:** 保留共同业务 release；将运行时和服务入口限制在平台适配层。复用现有 FPK 运行时与验收，通过统一元数据及最终汇总阻止混包或部分成功交付。

**Tech Stack:** Node 24.22.2 / ESM / SQLite / GitHub Actions / 官方 Node ZIP / WinSW / systemd / fnpack。

**Spec:** ../specs/2026-11-09-environment-packages.md

## Global Constraints

- 用户批准直接实施；子智能体 gpt-6-luna、low，禁止 Astra。
- 不停现有 ERP，不进行正式部署、安装、账本测试或公网发布。
- 不复制业务、不引入 Electron、不改变锁/密码/审计规则。
- Windows x64、Linux Debian12 glibc>=2.36 x64、fnOS x86。
- 程序/运行时与持久数据隔离；不得静默覆盖已有目录或初始化正式账本。

## Review Focus

- Linux Xvfb 的 helper 路径不能继续指向 fnOS target。
- 包内 Node、平台依赖与实际启动命令一致，不能被系统 Node/PATH 掩盖。
- Windows/Linux 配置不得伪造 fnOS 身份，fnOS 默认行为不得回归。
- 父目录、链接、路径空格、重复配置与已有数据必须安全失败。
- 产物下载和重新解包验收必须对应同一 workflow/run，不能以源码测试替代。

## Task 1 — common identity and Windows environment

- [ ] 新增 deploy/environments/metadata.mjs：从已验收 release 计算规范业务摘要；生成/校验 environment-build.json。
- [ ] 新增 deploy/environments/package.mjs：复用 verifyRelease，向全新目录复制 erp/ 与 runtime/，拒绝数据泄漏和输出覆盖。
- [ ] Windows 脚本使用包内 runtime/node/node.exe，转发显式参数，提供可选服务操作说明。
- [ ] 固定官方 Windows Node ZIP 的 SHA，保留其许可证，不把运行时路径写成构建机绝对路径。
- [ ] 先 RED，再验证 metadata 混版本/修改源/已有目录拒绝，以及实际包内 Node 启动。

## Task 2 — shared environment entry and Linux environment

- [ ] 新增 server/environment.mjs 作为非 fnOS 包命令，复用现有 native supervisor/lifecycle；fnOS 旧命令保持不变。
- [ ] 最小扩展 configureNative 的显式非 fnOS 入口，用现有 HTTPS/Tailscale auth，不创建假 NAS UID。
- [ ] deploy/linux/ 添加非 root 服务模板、配置/启动说明和验收脚本。
- [ ] prepare-native-runtime.sh 在统一构建开启时额外编译 /opt/wuchengerp/runtime helper 前缀的 Xvfb，保留参数及来源。
- [ ] 从相同 accepted erp 和运行时复制 Linux envelope，仅替换新包的 Linux Xvfb，完整保留 FPK 原产物。
- [ ] 在隔离 Debian12 前缀安装、以包内 Node 启动三模块及浏览器并停止；不关闭 sandbox。

## Task 3 — one-run delivery gate

- [ ] 新 environment-release.yml 编排 Windows 与 Linux/fnOS，共同 commit/version/runId。
- [ ] fnos-native.yml 支持 workflow_call，复用原有检查，避免一次 push 重复构建完整 FPK。
- [ ] Windows 在 windows-latest 构建，Linux/fnOS 在现有 Debian12 构建环境构建。
- [ ] 汇总脚本验证三个 target、共同源码摘要、身份、每包 SHA 与各验收结果；缺任意一包失败。
- [ ] 上传同次产物和 source companion，不自动部署或公开发布。

## Integration

- [ ] 主智能体检查 diff、API 和平台边界，修复后再提交推送。
- [ ] GitHub 检查通过后下载同次三个包，核对 SHA 和内容/元数据。
- [ ] Windows 本机隔离运行验收；Linux/fnOS 查看同次实际非 root runtime 验收及清理证据。
- [ ] 交付链接与范围，明确正式 ERP 保持原部署。

### Adapter contract for parallel work

`deploy/environments/package.mjs` CLI: `--target windows-x64|linux-x64 --release <accepted erp> --runtime <prepared runtime root> --output <new envelope dir> --commit <40hex> --run <decimal>`。输出包含 erp/、runtime/、environment-build.json；平台脚本从 deploy/environments/templates/<target>/ 复制。包体打包及 SHA 由各平台构建脚本完成。

`deploy/environments/metadata.mjs` 导出 `sourceDigest(releaseRoot)` 和 `buildMetadata({releaseRoot,target,commit,runId,nodeVersion})`。元数据字段按 spec，不把 accepted:false 作为有效源；metadata authority 可使用 clean Git source 验证后只生成预期版本/commit/runId，汇总以实际三包相同摘要为必要条件。

`deploy/linux/build-environment.sh` 接收 `<accepted erp> <prepared runtime> <linux Xvfb> <output dir>`，必须只写新输出。由 build-native.sh 在正常 FPK 完成后、统一构建参数开启时调用；原 FPK 构建与 clean 验收不删减。
