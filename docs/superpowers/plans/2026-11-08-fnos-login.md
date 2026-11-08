# 飞牛登录接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 飞牛统一网关登录进入既有Docker ERP，保留Tailscale备用及唯一账本。

**Architecture:** 一个运行时、网关状态库及服务owner，增加受控Unix入站；身份提供商隔离。公开路径带/app/wuchengerp前缀，模块前缀由签名actor绑定。薄FPK仅注册入口。

**Tech Stack:** Node24、Fastify5、SQLite、fnOS统一网关、fnpack1.2.3。

**Spec:** docs/superpowers/specs/2026-11-08-fnos-login-design.md

## Global Constraints

- 不伪造Tailscale身份或固定管理员，不接收TCP X-Trim头，不开放任意Origin或空UID名单。
- 保留唯一运行时/账本、现有挂载、备份及Tailscale；正式账本不做测试写入。
- 实测UID1000，NAS实例f3589ebc5e0145b089cde167cef7e7cbbe3194ed；配置默认关闭。
- FPK wuchengerp、前缀/app/wuchengerp、socket app.sock；Unix0600不覆盖旧socket。

## Review Focus

- NAS去掉Host端口但浏览器Origin保留端口；不得反射任意源。
- 身份提供商间用户名碰撞与fnOS账号改名；审计主体始终稳定。
- 模块workbench-base.js、JSON文件URL及Cookie不能丢失应用前缀。
- 双入口与启动失败不产生第二owner，不删除别人的socket。
- FN Connect自动LAN跳转不代表公网中继通过；正式数据验证必须只读。

### Task 1: Unix身份与同运行时网关

Files: server/config.mjs, server/runtime.mjs, server/gateway/{gateway,store,company-access}.mjs，新增聚焦身份/Unix helper；tests/web-fnos*.test.mjs及相关gateway/config/runtime测试。

Interfaces: config.fnos={enabled,instanceId,socketPath,basePrefix,allowedOrigins,allowedUids}; actor.publicPrefix是签名声明（空或/app/wuchengerp），actor.id保持provider-qualified。公开前缀从当前请求可信入口上下文获取。原注册路由使用内部无前缀路径。

- [ ] 先写并运行失败测试：真Unix登录UID1000成功、TCP同样header失败、未授权/重复/畸形拒绝、跨provider cookie不复用、改名ID不变；旧记录迁移保留。
- [ ] 实现同Fastify路由及store的独立listener，路径和Host/Origin/CSRF严格校验，写入排空覆盖双入口。
- [ ] 验证socket0600、既有socket拒绝覆盖、启动失败清理仅本进程socket、两个入口serverId/dataSetId相同、Tailscale原测试通过。
- [ ] 提交任务范围代码；记录检查结果。

### Task 2: 子路径UI与模块签名前缀

Files: server/public/{index.html,shell.js,data-versions.html,data-versions.js}；apps/{purchase,sales,overview}/lib/workbench-module.mjs与public/workbench-base.js；相关聚焦测试。不得修改Task1文件，和后端协调必要runtime静态HTML重写。

- [ ] 先写并运行失败测试：/app/wuchengerp下shell资源、三模块/API、数据版本、下载URL、Cookie/跳转保留前缀；未签名前缀不得生效。
- [ ] 消费签名actor.publicPrefix，统一UI/JSONURL转换；前端从自身脚本/页面路径获得受限前缀，保留现有无前缀桌面/Tailscale行为。
- [ ] 运行三模块workbench聚焦测试与根UI检查；提交任务范围代码。

### Task 3: FPK安装与正式切换

Files: 新增 deploy/fnos/wuchengerp包、官方fnpack构建脚本/说明、FPK结构验证测试；必要release版本及验收文档。

- [ ] 用官方模板构建薄FPK，生命周期仅检查目标socket/入口，停用不停止ERP；不挂Docker socket或业务目录。
- [ ] 独立代码审阅与集成测试；GitHub CI/NAS构建通过。
- [ ] 隔离Linux镜像验证双入口与完整页面，正式停写备份/恢复验证，修改实际compose添加精确socket目录挂载及配置后切换唯一实例。
- [ ] 只读核对身份、三模块报表摘要和版本托管；验证FN中继入口及Tailscale，移除临时探针，保留最终入口。
