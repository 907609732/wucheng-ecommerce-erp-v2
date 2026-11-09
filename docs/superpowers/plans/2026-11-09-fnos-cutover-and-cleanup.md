# 飞牛原生 ERP 收尾与清理执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute the existing reviewed implementation and this operational runbook continuously. No new product implementation or repeated broad review is planned.

**Goal:** 将现有 ERP 账本迁移到不依赖 Docker 的飞牛应用，保留双入口和可恢复备份，再清理已确认废弃的产物。

**Architecture:** 复用已完成代码审查的原生应用；通过官方应用中心安装，使用 GNU tar、SHA256、SQLite 和已实现的迁移／UVCS 工具验收。原始备份、恢复验证副本、迁移工作副本分别保存。

**Tech Stack:** fnpack FPK、Node 24.22.2、Debian 12 x86_64、Chromium、noVNC、SQLite、官方 UVCS CLI、GitHub Actions。

**Spec:** docs/superpowers/specs/2026-11-08-fnos-native-design.md

## 约束与关卡

- 正式账本只用于迁移和只读核对，不用于测试锁定、付款或导入。
- Linux 产物构建来源为 594aeec；后续 83d06aa 仅精确处理公开协议 nonce 的扫描误报，不改运行代码。分别记录软件来源和 CI 元数据来源。
- 先通过隔离诊断与完整停写备份，才安装主包；保留原 serverId、dataSetId、fnOS 实例和 Tailscale 入口。
- 原始数据库、锁、密码配置、审计、outbox、快照、原件、完整 workspace、UVCS HOME 和浏览器配置都须纳入备份。
- 不静默关闭 UVCS、不重建替代工作区、不重写业务 SQL。
- 每步验收失败先定位或回退，不把未执行的关卡标为完成。
- 清理限明确废弃的 ERP 测试资源和旧产物；不执行全局 volume prune、不删除正式账本及必要回退材料，不动其他业务应用。

## 执行清单

- [ ] **1. 最终产物与检查。** 594aeec 基线产物已下载并完整验证；实机动态依赖修复后，重新验证最终候选的 PR21 检查和同次主包、诊断包、源码伴随包。核对服务端 ZIP digest、三个本地文件 SHA256、全部源码成员及九份实际验收报告，更新 delivery-summary 和 source-contents-verification。
- [ ] **2. NAS 独立诊断。** 复用专用飞牛窗口；上传有明确版本名的诊断包并核对 NAS 文件。仅安装诊断包，读取实际 acceptance，要求 Node／SQLite／沙箱／中文／RFB／下载／重启及 cleanup 通过。正式 Docker 保持运行到此步结束。
- [ ] **3. 停写与备份恢复。** 记录最新三模块摘要、实例身份和 UVCS 全队列；停止 ERP／collector／两浏览器，确认退出。向备份卷唯一私有目录归档完整源、HOME、整份浏览器配置、旧应用／Compose 与回退 FPK。核对 SHA 和恢复副本的全部 SQLite、原件及业务状态。
- [ ] **4. 原生主应用迁移。** 从原始备份生成独立 normalized 副本，仅调整已核实的权限和失效运行锁；浏览器 user-data 内容放入各自目标根。绑定原工作区身份并 seal，通过官方向导迁移；在最终物理路径登记同一工作区。失败保留账本和 pending 状态，不创建空库。
- [ ] **5. 正式验收与合并。** 以真实 package UID 验证官方 UVCS 仓库和全部已提交事件；检查两个入口同一身份及三份摘要、锁／密码／审计／原件。完成启停与端口检查，关闭旧 ERP 容器自动重启并保留回退。检查全绿后按已授权流程合并 PR21，记录实际安装包 SHA 和备份位置。
- [ ] **6. 废弃资源清理。** 先列 Docker 容器／镜像引用及本地产物库存，明确保留集合，再删除可证明废弃的 ERP 测试容器、无引用且不作回退的镜像、过时安装包和重复 ZIP／源码归档。逐批记录实际释放空间；保留当前包、匹配源码、旧薄壳回退包、迁移备份和关键验收证据。

## 失败与回退

实际执行顺序调整：实机发现旧正式项目及飞牛入口已停用，仅两套采集浏览器仍运行。因此停止剩余浏览器后提前制作停写备份，与软件上传并行；不为获取摘要而重新启动旧正式写入服务。独立诊断仍必须在安装主包之前通过。

2026-11-09 实机记录：原始归档 `/vol3/wucheng-erp-backups/erp-native-before-20261109T050621445Z-1/raw.tar` 为 854568960 字节，SHA256 `f714b4b74fb84a1be662ac1f29c6a9a5447835ee628a6fb766e3209067e69883`。GNU tar 对源和恢复副本的对比通过；恢复副本 77 个 SQLite 完整性检查通过，4597 个普通文件，原 UVCS 工作区身份已捕获。NAS 上两份 594aeec FPK 的大小和 SHA 与本地已验证下载一致。

2026-11-09 诊断阻断：`run-20261109T052421Z-1504770` 已通过首次启动、HTTPS、MCP、下载、noVNC/RFB 键鼠并完成清理，但运行库审计发现 Chromium 加载宿主 NSS 外置插件、dconf、Vulkan/VA 库，因此安装失败。正式主包未安装、正式账本未迁移。Ruling: 只修复这次实机证实的动态依赖闭包与搜索路径，保留原审计拒绝策略，增加针对性回归并重建同次产物后再验收；不重复全分支调研，不靠修改 NAS 全局环境或关闭沙箱通过。

2026-11-09 迁移准备：已核对原包用户 947:901。独立副本 `/vol4/@wuchengerp-data/backups/native-migration-20261109-final/normalized` 含 3516 个逐文件比对通过的普通文件，仅省略已核实的三份旧容器 PID 记录和六个当前 profile 的失效 Singleton 链接。原始归档、恢复副本未修改，可信原工作区身份另存于本次私有目录；尚未 seal 或发布正式数据。首次空目录属主检查拒绝后，实查确认空根为 root:root 0755，仅初始化这一空目录为包用户与 0700 后才生成新副本，未递归修改旧数据。

2026-11-09 本地清理：两份已解压、全量 SHA 校验且对应源码成员已验证的下载 ZIP，通过 Send2Trash 移入 Windows 回收站，工作目录减少 3223780248 字节；不宣称回收站占用已经从磁盘释放。FPK、对应源码归档、回退包、正式备份及验收证据保留。Docker 镜像与容器库存已保存，删除尚未执行。

2026-11-09 后续记录：独立副本已由既有 `seal-source` CLI 以辅助容器数字 UID 947 封存，3516 个文件与复制证明完全一致、原工作区身份匹配。此为复制与封存证明，不替代真实宿主的 package UID／UVCS 验证。使用的 594aeec 封存 CLI 与当时 HEAD 在 configure、lifecycle、UVCS registration、stored-file 上字节相同。

2026-11-09 CI 收敛：a7c2cb1 的 Linux FULL run42569021340 中，四套业务测试 322／198／214／98 均零失败；Windows 检查通过。新增污染宿主验证已证明私有 NSS 插件实际加载、GIO／VA／Vulkan loader 闭包修复，但 Chromium pre-sandbox hook 仍直接加载宿主 Intel／Radeon 驱动，因此产物被拦截。按固定版本官方源码补入 Mesa Vulkan 全部共享库与依赖，保留原审计。Ruling: 后续窄构建改动重跑 native focused 套件与完整真实主／诊断包、污染宿主和 clean runtime 验收，Windows 自动全量检查继续；不重复已通过且未再改动的业务套件。

本地已另将两个早期失败候选目录内的 8 个大安装包／源码归档／重复 ZIP 移入回收站，保留日志与元数据；连同前述 ZIP 累计移走 12159760346 字节，当前 594aeec 候选与对应源码、旧薄入口回退包仍保留。

2026-11-09 隔离迁移演练：额外工作副本通过原件引用校验与原工作区本地登记，三模块主数据库 SHA 与封存源完全一致、gateway identity 不变；没有启动正式服务或云端 worker。此辅助容器结果仍不替代实际宿主验证。

2026-11-09 ef26f95 构建：污染宿主 smoke 已通过两次启动、33 个进程 maps、namespace/seccomp、MCP、RFB、下载、持久会话与清理，私有 Intel/Radeon 加载断言通过。随后必需的 libffi 源码 URL 连续返回 504，故没有放行 FPK。只为该精确 URL 添加相同官方 release asset API 回退，并固定既有 1581626 字节与 SHA256；实际 API、旧对应源码记录和官方 asset digest 一致，坏校验不回退、不发布。Windows 出现两项 fresh setup 子进程退出失败，现有日志不足以定因；测试仅增加删除 stage 前的受限错误码／栈和端口观测，不改变异常、清理、断言或重试。下一轮检查继续捕获实际原因，不能把未重现等同于修复。

2026-11-09 6b77983 后续：运行库验证继续通过，源码收集又遇到另一 GitHub release（Little-CMS）的四次 504。已一次性核对固定 sharp-libvips 1.3.4 recipe 的全部 8 项 GitHub release asset，官方元数据、旧已验证来源记录与实际下载的 44697104 字节 SHA／大小全部一致；静态精确映射优先官方 API，只有同项原 URL 可回退，未知 release URL 在网络前拒绝，校验失败不回退。

该轮 Windows 的 root 测试已通过；sales 的 50 MiB 上传恢复测试在模拟断线之前遭遇真实 ECONNRESET。两次受控停顿未复现，不能认定 keep-alive 原因。仅对这一合成用例增加实际请求／响应／落盘状态的有限观测，并在原模拟断线之前明确核对第 0 块的 DB、1 MiB 文件与 SHA；保持原断线正则、重启后 49 块恢复、最终 50 MiB SHA、重放及超限断言。不得把观测补丁称为真实断线根因修复。

新原生服务停止并确认所有权范围内进程／端口释放后，通过官方应用中心恢复旧入口，启动保留的旧 Docker 服务重新生成真实 socket。若原生已产生合法新业务写入，回退程序必须使用当前兼容账本，禁止用旧备份覆盖新数据。

## Review Focus

- 下载内容与实际软件提交、文件哈希一致；不混用旧候选包。
- 诊断应用与正式实例使用不同 UID、数据根、端口。
- 停写证明来自真实容器状态；不能信任 Docker 命名空间旧 PID。
- 迁移副本清理与权限调整不得触及原始备份。
- 删除前核对容器引用、活动文件和保留清单；缺少归属证据的对象保留。
