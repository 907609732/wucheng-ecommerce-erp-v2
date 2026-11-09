# fnOS 并行隔离试装与迁移

用户授权：先在 NAS 安装完整原生应用，用隔离账本与飞牛中转实际验收；通过后再完整备份、恢复验证及迁移，保护原 Docker ERP。开发/复核仅 gpt-6-luna / low。

## 当前约束与决定

- 已验收的 0.15.0 主包 app ID 为 wuchengerp，与仍正常服务的 0.14.4 薄壳相同，不能直接升级作为试装。2026-11-10 中转健康检查返回 200、fnOS ready。
- 独立试装 app ID 固定 wuchengerptrial，入口 /app/wuchengerptrial，数据根 @wuchengerptrial-data，独立平台 VAR、UID、socket、回环浏览器端口和 display。只允许主/试装这两个受控前缀；不改变既有实例、迁移源身份或默认主包行为。
- 复用已有 fnpack、Debian Xvfb 构建及 FPK 验证机制，按试装 target 另编 Xvfb；不改原 FPK 的字节、不制作指向正式 target 的别名、不关闭 sandbox。
- 官方开发文档本轮 web 工具访问失败；现有实测 SDK/源码为实施依据，没有引入新的第三方框架。

## 实施与关卡

- [ ] 后端显式受控 trial 前缀与独立浏览器配置，保持默认主包兼容、错误前缀拒绝，针对性回归。
- [ ] 既有 builder 可选生成完整 trial FPK；main/diag 原产物不变。trial 的独立 Xvfb、manifest/UI/data recovery 钩子和向导全部一致。
- [ ] CI 生成与验收 trial，重新核验包哈希及对应源码；试装包保持与同次业务 release 相同源码。
- [ ] NAS 读取现有 app、Docker 健康/挂载、安装卷/VAR/用户及空闲端口；所有试装目录必须全新独立。
- [ ] 经应用中心安装 trial/fresh，仅合成账本；验证真实非 root 三模块及两浏览器、目录权限、隔离身份、飞牛登录后中转访问、匿名拒绝、启停及重启后账本保持，原服务继续可用。
- [ ] 通过后停写排空并制作新的完整正式备份（不能沿用旧备份冒充当前）；恢复校验 SQLite、原件、月锁/密码/审计、UVCS/HOME/profile/实例身份。
- [ ] 主包迁移仅使用封存副本，唯一正式写入实例；验收中转及主机 Tailscale 备用入口，失败回到原服务，保留全部新旧数据与证据。

当前迁移关卡未满足，禁止停正式容器、升级正式薄壳、改正式账本或转发配置。浏览器 TaskSpace 18：p1 局域网登录，p2 已登录中转；浏览器交给用户完成局域网登录时继续独立代码/CI 工作。
