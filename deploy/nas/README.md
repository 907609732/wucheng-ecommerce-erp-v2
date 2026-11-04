# NAS 隔离验收项目

此目录存放飞牛 NAS 上的容器构建文件。先运行合成账本验收，再准备常驻服务和正式数据切换。

NAS 固态盘团队目录 `五成ERP-NAS` 当前布局：

```text
五成ERP-NAS/
  acceptance/                      # Compose 测试项目目录
  releases/
    nas-upload-20261104.zip        # 保留上传原件
    nas-upload-20261104/
      nas-upload-20261104/         # 解压后的实际构建目录
        Dockerfile
        .dockerignore
        web-release.json
        _build-cache/xlsx-0.20.3.tgz
        apps/
        server/
```

在 GitHub Actions 的 `NAS Linux image` 同次构建产物中取得 `REGISTRY-IMAGE.txt` 和两份已写入提交号的 Compose 文件。镜像由该工作流发布到 GHCR；飞牛 Docker 可直接按 `REGISTRY-IMAGE.txt` 拉取，Compose 也使用同一个不可变标签。若仓库拉取不可用，产物仍有 `wucheng-erp-linux-amd64.tar`、`SHA256SUMS.txt` 和 `IMAGE.txt`，先核对 SHA-256，再尝试在飞牛 Docker 的“本地镜像”导入。将产物中的 `compose-acceptance.yml` 作为 `acceptance/docker-compose.yml` 创建 Compose 项目。该任务不映射端口、不挂载正式数据，结束后应显示成功退出码和 `"ok":true` 的三模块验收结果。

NAS 的 `docker.fnnas.com` 镜像代理曾对 `node:24-bookworm-slim` 返回 401。当前改为在 GitHub Linux runner 上完成依赖安装、合成账本验收和镜像构建，NAS 不再安装 npm 依赖。镜像基底使用 Docker 官方 Node 镜像在 Amazon ECR Public 的地址。采购台的 SheetJS 固定版本来自独立 CDN，GitHub 构建仍依据锁文件检查完整性。NAS 上原有源码构建目录和缓存包仅供回溯，不作为新部署入口。

本次上传原件 SHA-256：`nas-upload-20261104.zip` 为 `79bed355495bdd7d35a64755cb993535005a4d41419beb41f5792c3338d31479`；缓存包为 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`。Windows 端发布清单已验收 338 个源码文件，合成账本覆盖采购、销售和总览；NAS 验收尚未完成。

2026-11-04 首个测试项目 `wucheng-erp-nas-test` 在 npm 安装阶段卡住。飞牛网页“停止构建”返回 `Succeed`，刷新后仍显示“构建中”。不要在未确认其他三个运行容器恢复方案前重启 Docker 服务或 NAS。

验收完成后，使用同次产物中的 `compose-service.yml` 放在 SSD 团队目录下独立的 `runtime` 文件夹，`serve.json` 放在 `runtime/tailscale-config/serve.json`。该配置不映射宿主机端口，ERP 只监听与 Tailscale 容器共享的 `127.0.0.1`。Tailscale 状态写在 `runtime/tailscale-state`，首次登录可在容器日志里取得交互授权链接；不要把授权密钥写进 Compose。`config-test.example.json` 仅用于隔离账本测试，必须先替换 HTTPS 域名并准备三个测试 SQLite 文件；正式迁移前还需启用数据版本和备份。
