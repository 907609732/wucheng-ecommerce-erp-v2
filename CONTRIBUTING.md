# 协作开发

## 本地环境

- Windows 10/11 x64
- Node.js 24、npm、Git
- 系统 Chrome（仅登录与真实采集时需要）

```powershell
git clone https://github.com/907609732/wucheng-ecommerce-erp-v2.git
cd wucheng-ecommerce-erp-v2
npm.cmd ci --ignore-scripts
npm.cmd run test:desktop
```

从 `main` 创建短期功能分支，通过 Pull Request 合并。禁止提交 `.env*`、登录态、Token、Webhook、库存文件、SQLite 数据库、日志和打包产物。

## 发布与升级

1. 更新 `package.json` 版本并合并到 `main`。
2. 创建匹配版本的标签，例如 `git tag v0.2.0`。
3. 推送标签后，GitHub Actions 自动测试、打包 NSIS/portable 并创建 Release。
4. 客户端凭只读 GitHub Token 检查私有仓库 Release；下载完成后点击“重启并安装更新”。

建议每位协作者创建 Fine-grained personal access token，仅选择本仓库并授予 `Contents: Read`，不要共享管理员 Token。
