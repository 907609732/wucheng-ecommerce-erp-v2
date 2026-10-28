# 开发与代码同步

## 环境和命令

使用系统级 Node.js 24+、Git、PowerShell。运行 `npm.cmd ci` 安装依赖，把 `config.example.json` 复制为本机 `config.json`。统计端点留空时不发送使用量上报；GitHub 更新检查不等于自动安装。

```powershell
npm.cmd run check
npm.cmd test
npm.cmd start
```

启动前确认 17868/17869 无其他实例；日常推荐启动/重启脚本核对服务、PID 和版本。不要同时启动多个实例写同一数据目录。

完整测试的中文 OCR 需要模型和 Windows 字体 `C:/Windows/Fonts/msyh.ttc`。CI 只运行语法与不依赖真实设备/中文字体的核心测试；不要把部分测试当作手机或安装验收。

## 目录

| 路径 | 说明 |
| --- | --- |
| `server.mjs` | 本机服务、共享保存与 OCR 入口 |
| `lib/` | 数据库、导入、月锁、审计、供应商和手机权限 |
| `public/` | 桌面与手机网页及共用模块 |
| `scripts/` | 启动、模型安装、备份校验与维护 |
| `tests/` | 使用临时数据目录的回归测试 |
| `deploy/examples/` | 脱敏 DERP 模板 |
| `licenses/` | 补充第三方许可证 |

手机与电脑写入同一本机数据库。手机有独立服务和接口白名单，新增功能须同时验证越权边界、月锁和事务去重。

## GitHub 同步

仓库默认私有，只管理代码和文档。`data/`、原件、附件、备份、日志、模型、`config.json`、环境凭据、Plastic 元数据和生产部署记录均排除。原 Plastic 工作区独立保留，不会被转换为 Git 历史。

常规功能变更建议使用 `codex/` 分支，运行检查后提交审阅。同步前检查暂存内容，并用 Gitleaks 等工具扫描；不要强制纳入被忽略的真实数据。

```powershell
git status --short
git diff --cached --stat
npm.cmd run check
npm.cmd test
git push
```

源码提交、GitHub Release、安装包和软件自动更新是独立步骤。首次同步不代表发布正式安装器；需要发布时另行构建与验收。

## 兼容约束

界面名称是灵兔采购台，内部 `purchase-desk` 标识、端口、数据路径及旧启动入口保留。迁移前完整备份，迁移须幂等，不改原件或删审计来通过测试。真实平台样本和手机网络验收不能用合成测试替代。
