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

- [ ] **1. 最终产物与检查。** 检查 PR21 当前 Windows 检查；下载 Linux run42537761253 的主包、诊断包和源码伴随包。核对服务端 ZIP digest、三个本地文件 SHA256、全部源码成员及九份实际验收报告。产出本地 delivery-summary 和 source-contents-verification。
- [ ] **2. NAS 独立诊断。** 复用专用飞牛窗口；上传有明确版本名的诊断包并核对 NAS 文件。仅安装诊断包，读取实际 acceptance，要求 Node／SQLite／沙箱／中文／RFB／下载／重启及 cleanup 通过。正式 Docker 保持运行到此步结束。
- [ ] **3. 停写与备份恢复。** 记录最新三模块摘要、实例身份和 UVCS 全队列；停止 ERP／collector／两浏览器，确认退出。向备份卷唯一私有目录归档完整源、HOME、整份浏览器配置、旧应用／Compose 与回退 FPK。核对 SHA 和恢复副本的全部 SQLite、原件及业务状态。
- [ ] **4. 原生主应用迁移。** 从原始备份生成独立 normalized 副本，仅调整已核实的权限和失效运行锁；浏览器 user-data 内容放入各自目标根。绑定原工作区身份并 seal，通过官方向导迁移；在最终物理路径登记同一工作区。失败保留账本和 pending 状态，不创建空库。
- [ ] **5. 正式验收与合并。** 以真实 package UID 验证官方 UVCS 仓库和全部已提交事件；检查两个入口同一身份及三份摘要、锁／密码／审计／原件。完成启停与端口检查，关闭旧 ERP 容器自动重启并保留回退。检查全绿后按已授权流程合并 PR21，记录实际安装包 SHA 和备份位置。
- [ ] **6. 废弃资源清理。** 先列 Docker 容器／镜像引用及本地产物库存，明确保留集合，再删除可证明废弃的 ERP 测试容器、无引用且不作回退的镜像、过时安装包和重复 ZIP／源码归档。逐批记录实际释放空间；保留当前包、匹配源码、旧薄壳回退包、迁移备份和关键验收证据。

## 失败与回退

新原生服务停止并确认所有权范围内进程／端口释放后，通过官方应用中心恢复旧入口，启动保留的旧 Docker 服务重新生成真实 socket。若原生已产生合法新业务写入，回退程序必须使用当前兼容账本，禁止用旧备份覆盖新数据。

## Review Focus

- 下载内容与实际软件提交、文件哈希一致；不混用旧候选包。
- 诊断应用与正式实例使用不同 UID、数据根、端口。
- 停写证明来自真实容器状态；不能信任 Docker 命名空间旧 PID。
- 迁移副本清理与权限调整不得触及原始备份。
- 删除前核对容器引用、活动文件和保留清单；缺少归属证据的对象保留。
