# Formal Data UVCS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 正式业务每次保存产生可恢复的数据版本，自动提交独立私有 UVCS 仓库，并在软件内查看。
**Architecture:** 模块事务内持久化事件与不可变业务数据快照，后台串行上传官方 cm，宿主提供鉴权查询与重试接口。业务快照使用经过白名单过滤的可恢复逻辑导出，避免整库包含授权；禁止仅监听成功响应后再读取活动库。
**Tech Stack:** Node.js 24、node:sqlite、Unity Version Control cm、现有 Fastify 与原生浏览器界面。
**Spec:** docs/superpowers/specs/2026-11-04-formal-data-uvcs-design.md

## Global Constraints

- 独立私有数据仓库；源码及 GitHub 不携带正式账本、附件或凭据。
- 一次业务事务一条事件；失败、回滚、只读、无变化不生成版本。外部不受控 SQL 写入需报保护异常。
- 快照与 outbox 必须在放行下一次写入前固定；断网不丢队列，云端确认后才显示真实提交号。
- 复用现有 Node、SQLite 和官方 cm，无新增依赖；不同实施任务仅修改各自文件。
- 正式启用前验证实际运行身份、云端私有权限、基线恢复和业务副本正确性，不清理其他未提交工作。

## Review Focus

- 连续保存与异步事务：事件快照不得混入后续记录；测试在 Task 1。
- 事务回滚、无变化、缓存语句及 RETURNING 写入：不得漏记或误提交；测试在 Task 1。
- 已远端提交但本地确认丢失：重启后查询 eventId 去重；测试在 Task 2。
- 路径重定向与秘密混存：白名单导出和附件拒绝越界；测试在 Task 1、2。
- 非法会话、CSRF 与页面脚本注入：不能读取数据版本或触发重试；测试在 Task 3。

## Shared Interfaces

- 捕获根目录配置：`config.dataVersion = {enabled:true, dir:absolutePath, workspace:absolutePath, repository:string, cmPath:absolutePath}`；模块仅通过 `LINGTU_DATA_VERSION_DIR` 获取 dir。缺省完全禁用，不误接正式数据。
- `shared/data-version-capture.mjs` 导出 `installDataVersioning({db,module,dataDir,versionDir})`，返回 `{run(context,fn),refresh(),baseline()}`；context 为 `{actor:{id,label}, action:string}`。env 未启用时调用方不安装。
- 已提交事件存在源账本表 `data_version_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL)`；事件文件目录 `<dir>/events/<module>/<id>/`，`snapshot.json` 存逻辑导出。
- 事件对象：`{schemaVersion:1,id,module,createdAt,actor:{id,label},action,summary,counts:{insert,update,delete},snapshot:{path,sha256},attachments:[{path,sha256,bytes}]}`。path 均为事件目录内相对路径；不得包含秘密。worker 必须从源库已提交事件查询，不信任孤立目录。
- `server/data-version/worker.mjs` 导出 `createDataVersionWorker({config,adapter?})`，返回 `{list(filters),detail(id),summary(),retry(id),tick(),close()}`；list 返回 `{items,total}`；detail 返回 `{...event,status,changeset,error,attempts}`，不对外暴露主机路径；summary 为 `{enabled,pending,failed,submitted,lastSubmittedAt}`。
- 官方适配器 `createUvcsAdapter({cmPath,workspace,repository})` 返回 `{findEvent(eventId),commit(event,eventDir),...}`，真实调用使用参数数组 shell:false，提交注释绑定 eventId，查远端去重先于上传。
- UI API：GET `/api/workbench/v1/data-versions`、GET `/api/workbench/v1/data-versions/summary`、GET `/api/workbench/v1/data-versions/:id`、POST `/api/workbench/v1/data-versions/:id/retry`；沿用 requireSession 与 CSRF；列表参数 module/actor/status/from/to/limit/offset。

### Task 1: 事务事件与业务快照

Files: shared/data-version-capture.mjs、必要的 shared/data-version-policy.mjs、三个 apps 的 lib/store.mjs（sales 为 db.mjs）及 lib/workbench-module.mjs；tests/web-data-version-capture.test.mjs。

- [ ] 编写并运行失败测试：连续保存不同快照、批量一条、回滚零条、无变化零条、直接 SQL 与 RETURNING、嵌套事务、附件拒绝越界、排除授权及基线恢复。
- [ ] 实现事务捕获：可在 COMMIT 前同步构建快照与 outbox，随事务回滚；孤立文件不作为提交来源。提交前失败应回滚业务，避免已经保存却没有快照。
- [ ] 明确业务表与必要非秘密设置白名单；快照包含恢复所需 schema、业务行、附件摘要及可复制文件，提供恢复到新目录的接口。
- [ ] 模块存储与工作台身份上下文接入；保留原生 SQLite 实例和已有事务所有权保护；安装后新增业务表刷新触发器。
- [ ] `node --test tests/web-data-version-capture.test.mjs` 为绿，记录 RED/GREEN 与限制。

### Task 2: UVCS 适配器与持久上传队列

Files: server/data-version/{uvcs,worker}.mjs、tests/web-data-version-worker.test.mjs。

- [ ] 先写失败测试：从已提交源事件读取、断网重试、串行上传、失败恢复、eventId 去重、篡改摘要及越界路径拒绝、列表过滤与重启状态保留。
- [ ] 实现官方 CLI 适配器，固定工作区快照路径，精确 add/checkin 范围与中文注释，确认真实 changeset。
- [ ] 实现独立 queue.sqlite 记录状态与重试；单写者跨进程锁；只从已提交 outbox 取事件，不上传全部数据目录。
- [ ] `node --test tests/web-data-version-worker.test.mjs` 为绿，并用隔离云端合成仓库做真实提交与历史查询。

### Task 3: 软件页面与宿主集成

Files: server/public/{index.html,shell.js,shell.css,data-versions.html,data-versions.js,data-versions.css}、server/data-version/routes.mjs、server/{runtime,services,config}.mjs、tests/web-data-version-routes.test.mjs。

- [ ] 先写失败接口测试：鉴权列表、详情、不泄露路径、CSRF 重试、禁用状态；UI 行为采用浏览器验证。
- [ ] 顶部“数据版本”与独立托管状态；列表筛选、中文摘要、真实 cs 号、侧栏详情和重试，沿用共享令牌；窄屏可用、textContent 渲染用户数据。
- [ ] runtime 管理 worker 生命周期、路由与静态资源，services 显式传递模块环境；配置禁用时不改变原有行为。
- [ ] 根与三模块适当完整测试、静态检查、浏览器操作验证。

### Task 4: 正式接入与恢复验收

Files: docs/data-version-operations.md、docs/data-version-acceptance-20261104.md；独立主机配置与运行身份。

- [ ] 检查授权数据存储范围、仓库私有权限与实际自动化身份；不复制私有凭据冒充登录。
- [ ] 正式副本验证表数量、关键业务汇总、附件摘要、远端恢复、保存延迟、断网补交和重启去重。
- [ ] 代码提交并推送功能分支，GitHub 检查；正式数据不上 GitHub。
- [ ] 保留现有维护备份与回退版本，经过验收再更新正式服务、启用基线，核对软件记录与真实 UVCS cs 号。
- [ ] 如服务身份或权限需要用户输入，只报告具体未完成项，不声称正式托管成功。
