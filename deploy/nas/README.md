# NAS 隔离验收项目

此目录存放飞牛 NAS 上的容器构建文件。先运行合成账本验收，再准备常驻服务和正式数据切换。

NAS 固态盘存储空间 4 上的 `五成ERP-NAS` 历史构建目录布局：

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

在 GitHub Actions 的 `NAS Linux image` 同次构建产物中取得 `REGISTRY-IMAGE.txt` 和两份已写入提交号的 Compose 文件。镜像由该工作流发布到 GHCR；飞牛 Docker 可直接按 `REGISTRY-IMAGE.txt` 拉取，Compose 也使用同一个不可变标签。若仓库拉取不可用，产物仍有 `wucheng-erp-linux-amd64.tar`、`SHA256SUMS.txt` 和 `IMAGE.txt`，先核对 SHA-256，再尝试在飞牛 Docker 的“本地镜像”导入。隔离验收 Compose 不映射端口、不挂载正式数据，结束后应显示成功退出码和 `"ok":true` 的三模块验收结果。

NAS 的 `docker.fnnas.com` 镜像代理曾对 `node:24-bookworm-slim` 返回 401。当前改为在 GitHub Linux runner 上完成依赖安装、合成账本验收和镜像构建，NAS 不再安装 npm 依赖。镜像基底使用 Docker 官方 Node 镜像在 Amazon ECR Public 的地址。采购台的 SheetJS 固定版本来自独立 CDN，GitHub 构建仍依据锁文件检查完整性。NAS 上原有源码构建目录和缓存包仅供回溯，不作为新部署入口。

历史上传原件 SHA-256：`nas-upload-20261104.zip` 为 `79bed355495bdd7d35a64755cb993535005a4d41419beb41f5792c3338d31479`；缓存包为 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`。Windows 端发布清单已验收 338 个源码文件。

2026-11-04 首个测试项目 `wucheng-erp-nas-test` 在 npm 安装阶段卡住。经用户确认后 NAS 已重启；原有 `jx-tunnel`、`qwrt` 和 `docker-home-assistant` 均恢复运行，旧测试项目现为“未构建”，保留供回溯。

## 2026-11-04 NAS 实测进度

- GitHub Actions [运行 41788288931](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/41788288931) 在 Linux 上完成发布验收、Docker 构建、`docker save` / `docker load` 回读校验，并发布 `ghcr.io/907609732/wucheng-erp-nas:nas-1afbd964fa25bea64ec1a69f6b873cdc74ec5142`。
- 飞牛网页从 SSD 的 tar 文件导入镜像返回“参数错误:失败出错”，纯英文路径复试仍失败；改用“从 URL 添加”后，GHCR 镜像已成功拉取到 NAS。
- 飞牛不允许在已有 Compose 项目的子目录创建另一个项目。独立团队目录 `wucheng-erp-acceptance` 中的 `docker-compose.yml` 已启动 `wucheng-erp-acceptance`，容器退出码为 0，日志中的采购、销售、总览三模块合成账本验收为 `"ok":true`。
- 独立团队目录 `wucheng-erp-runtime-test/nas-runtime-test-41788288931` 存放仅含合成账本的常驻测试配置。`wucheng-erp-runtime-test` 的 ERP 和 Tailscale 容器均已运行；ERP 本机健康端点为 HTTP 200，三个 SQLite 文件的 `PRAGMA integrity_check` 均为 `ok`。
- 原侧车 Tailscale 容器的交互登录在约一分钟后超时并重启，授权过的设备没有成为当前运行实例；Windows HTTPS 握手失败。随后确认飞牛系统自带的 `wucheng-fnevo` Tailscale 节点已经在线（`100.125.50.16`）。按用户要求改为复用这个节点；侧车测试项目保留到原生入口切换完成，再停止。正式账本、附件与网关身份尚未迁移，Windows 正式写入口仍在运行。预迁移备份在普通权限下被 Windows LocalSystem 服务的维护管道拒绝，未创建备份目录；后续需通过管理员权限运行并校验。

下一步使用同次构建产物中的 `compose-service.yml` 在 SSD 独立目录部署 ERP。该配置只启动 ERP，使用 host 网络；网关继续仅绑定 NAS 的 `127.0.0.1:28430`，不映射 LAN 端口。先检查飞牛原生 Tailscale 已有 Serve 配置，再添加独立的 HTTPS 端口，将其代理到 `http://127.0.0.1:28430`，并核对实际注入的 `Tailscale-User-Login` 身份头。`config-test.example.json` 用于隔离账本测试，须将 `publicOrigin` 改为原生节点的 HTTPS 地址，并准备三个测试 SQLite 文件；正式迁移前还需启用数据版本和备份。历史 `serve.json` 属于侧车方案，原生方案不使用它。

2026-11-04 16:40 左右：`wucheng-erp-native-test` 已在存储空间 4 的独立团队目录运行，Compose 只含 ERP，使用既有 GitHub 镜像与三份合成账本。NAS 本机 `127.0.0.1:28430/api/workbench/v1/health` 返回 200；Windows 直连 NAS LAN 的 28430 被拒绝。飞牛原生 Tailscale 的 `serve status --json` 仍为 `{}`，故 8443 HTTPS 尚未开通。原生 Serve 写入需要 root 或由 root 指定 operator；普通 NAS 管理员的 CLI 请求被拒绝。等待用户确认浏览器 SSH 临时设备及在该浏览器终端输入 sudo 密码。等待期间已关闭飞牛 Tailscale SSH，访问策略中撤销临时 TCP 22，仅保留 Windows `100.108.102.40` 到 NAS `100.125.50.16` 的 5666、5667、8443。旧 `wucheng-erp-runtime-test` 两个侧车测试容器已停止且保留项目目录；`wucheng-erp-native-test` 与原有 `jx-tunnel`、`qwrt`、`docker-home-assistant` 仍运行。正式数据尚未迁移，Windows 原服务仍在运行。

2026-11-04 后续实测：GitHub Actions [运行 41803051900](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/41803051900) 对提交 `116893dc11385320de482b660f906c549114d0b8` 的 Linux 数据版本恢复测试、发布验收、镜像构建及上传均通过。NAS 已从 GHCR 拉取并运行同一提交的镜像，Docker 状态 `healthy`，重启策略 `unless-stopped`，数据仍在 `/vol4/@team/wucheng-erp-native-test`。飞牛原生 Tailscale Serve 在 `8443` 代理到仅监听 `127.0.0.1:28430` 的 ERP；Windows HTTPS 健康接口返回 200，证书验证通过，真实会话识别 Tailscale 用户，伪造身份头不能覆盖真实身份。Windows 的 ChatGPT 内置浏览器已打开采购、销售、经营总览三个模块；当前仅为合成空账本，数据版本页面明确显示未启用托管。测试数据的停机快照已备份至异盘 `/vol3/wucheng-erp-backups/acceptance-20261104/native-test.tar`，SHA-256 校验通过，恢复副本的三个 SQLite 数据库 `PRAGMA integrity_check` 均为 `ok`。正式 Windows 账本与附件、Linux 菜鸟采集、Linux UVCS、NAS 重启后验收尚未完成；原 Windows 服务仍是正式写入口。临时 Tailscale SSH 与 TCP 22 权限需在管理操作结束时撤销。

2026-11-04 17:43 左右：GitHub Actions [运行 41808525080](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/41808525080) 构建并验证带 Unity 官方 Linux UVCS CLI 的镜像 `nas-abbc11b345dd7ff26b6f5eaf7518e0b5a063a068`。飞牛 Docker 网页从 GHCR 拉取该不可变标签，停止隔离项目、修改 Compose 镜像并执行“构建”；容器详情显示新标签和新的创建时间，Windows HTTPS 健康接口仍返回 200。飞牛 Docker 服务开机自动开启，ERP Compose 保持 `unless-stopped`。Tailscale 策略中已移除临时 TCP 22，飞牛 Tailscale SSH 开关已关闭；Windows SSH 到 NAS 超时，而 8443 HTTPS 仍通过。Windows 正式账本备份脚本位于 `windows-precutover-backup.ps1`，资源管理器启动入口位于 `run-windows-precutover-backup.cmd`；截至此记录，管理员备份尚未成功执行，旧 Windows 服务仍在运行。Linux UVCS 仅验证安装，尚未完成仓库认证、提交与恢复验收。
