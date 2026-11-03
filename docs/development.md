# 开发

系统环境为 Node.js 24 或更新版本、npm、Git 和浏览器。业务依赖按锁文件安装，根目录及三个模块分别执行 `npm.cmd ci --ignore-scripts`。无需 Electron、Java、桌面编译工具链或新的前端框架。

`npm.cmd run web:dev` 启动隔离数据入口。前端改完刷新；模块后端改完在空闲时重启对应模块；修改宿主需要重启开发命令。不在开发模式连接正式账本。

```powershell
npm.cmd run web:check
npm.cmd test
npm.cmd run test:purchase
npm.cmd run test:sales
npm.cmd run test:overview
npm.cmd run sync:approval
```

Windows CI 运行同样的源码与业务测试，不生成安装器。正式候选由 `server/release.mjs` 安装锁定依赖并在独立合成账本上验收；更新流程见 [运维说明](browser-service.md)。

保留 `.git`、`.plastic` 及已有未提交业务资料。配置、密钥、账本和登录资料不进入普通源码提交；历史桌面实现从 Git 追溯。
