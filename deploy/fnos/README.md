# 五成ERP飞牛入口薄FPK

此包只把 `/app/wuchengerp` 注册到飞牛统一网关，并检查 `${TRIM_APPDEST}/app.sock` 是否为正在监听的Unix流式Socket。它不包含ERP程序、代理服务、Python/Node运行时、账户凭据、业务配置或账本；不操作Docker，不开启TCP，不创建另一套ERP。

官方依据：[统一网关](https://developer.fnnas.com/docs/core-concepts/gateway-registration/)、[Docker接入](https://developer.fnnas.com/docs/examples/docker/)、[应用权限](https://developer.fnnas.com/docs/core-concepts/privilege/)、[fnpack](https://developer.fnnas.com/docs/cli/fnpack/)。骨架由官方fnpack 1.2.3 `create wuchengerp` 生成，随后按最小权限精简；最低国内版fnOS为1.1.3100。

## 生命周期与安全边界

- `run-as=package`，无附加组、共享目录或文件授权。
- `start`/`status`先用POSIX `cd -P`解析官方target符号链接的物理目录，再读取ERP写入的0644普通文件`app.listener`（不含凭据），拒绝符号链接、多行和非严格小写UUID的`.erp-<UUID>`basename；检查`app.sock`与该私有Socket都是非符号链接Socket且`test -ef`证明同一inode；最后匹配`/proc/net/unix`中本代私有Socket的精确路径、监听标志及类型，判断入口存在，不连接Socket，不发送任何身份字段。`start`失败返回1并输出配置提示；`status`未就绪返回3。
- 此检测仅证明存在监听入口，不证明ERP健康、业务身份或数据集正确；上线验收必须另做真实网关登录和只读业务检查。
- `stop`及安装/升级/配置/卸载钩子均不操作ERP或Socket。停用/卸载本包不停止ERP，Tailscale备用入口仍由原服务提供。fnOS管理其自身安装目录；升级或卸载入口前应协调现有ERP的Socket挂载，不能将本包目录作为任何业务数据目录。
- Shell不需要Python；只使用fnOS/Linux的`sh`、`awk`、`test`和`printf`。目标Socket保持ERP root所有、0600；不会扩大权限让应用包用户连接。
- 精确Socket路径必须在宿主和现有ERP容器中一致，且复用既有host网络命名空间，才能匹配`/proc/net/unix`记录。不得挂载Docker socket、主机根或业务目录到本FPK。

## 安装与切换顺序

1. 在隔离环境审阅、构建此包，手动安装到NAS。唯一ERP尚未添加Socket挂载时，安装包可落盘，应用启用应明确失败；不要为使图标变成运行中创建占位Socket。
2. 记录官方安装目录的实际路径。示意为`/var/apps/wuchengerp/target`，容器只新增这个目录的精确同路径挂载，例如`<PHYSICAL_APP_TARGET>:<PHYSICAL_APP_TARGET>:rw`，其中`<PHYSICAL_APP_TARGET>`必须通过`cd -P /var/apps/wuchengerp/target && pwd -P`实测获取，ERP配置中的socketPath同样使用该物理目录下的`app.sock`，保留所有原有挂载、HOME、网络和数据。
3. 经停写备份、恢复验证后，更新现有唯一ERP容器及经审阅配置。配置默认关闭，`instanceId`、授权UID、允许Origin必须填实际验收值。示意占位：`<NAS_INSTANCE_ID>`、`<AUTHORIZED_NAS_UID>`、`https://<VERIFIED_FN_CONNECT_HOST>`、`http://<VERIFIED_NAS_LAN_IP>:<NAS_HTTP_PORT>`；不要将这些占位值或宽泛Origin名单上线。
4. ERP以root创建并持有0600 Socket；确认真实网关登录、伪造身份头覆盖/拒绝、匿名失败、两入口serverId/dataSetId相同、三模块只读摘要和版本队列后，再启用本包入口。
5. NAS自动切LAN直连与FN Connect外网中继须分别验证，不能将当前LAN成功称为中继验收。

## 构建（本次实现不执行构建、发布或安装）

官方工具共享路径：`C:/Tools/fnpack/fnpack.exe`，版本1.2.3。官方Windows下载来源为`https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64`。

```powershell
./deploy/fnos/build.ps1 -OutputDir C:/Users/<USER>/.codex-artifacts/erp-fnos-packages
```

脚本只调用官方CLI，不实现归档格式。每次创建唯一构建目录，只复制显式文件名单；不会打包工作目录中的日志、`.env`、真实`config.json`、密钥、数据库或其他未列出的文件。图标直接复制既有`shared/ui/loading-logo.png`，不修改位图；源包中的图标也为该文件的原样副本。保留官方CLI生成的FPK和SHA256清单，构建目录可独立审阅。

fnpack在Windows上生成的生命周期脚本模式需在首次构建时检查；仓库将cmd钩子标为可执行并强制LF。不要自行重写FPK/tar打包器来弥补模式问题。

## 验证

```text
node --test tests/web-fnos-package.test.mjs
```

测试包含结构、禁止越权命令、缺失Socket、普通文件伪装Socket、stop不改文件和官方CLI构建边界。Linux集成测试直接调用后端`createFnosListener`创建真实入口，检查本代`app.listener`、私有绑定Socket与公开hardlink同inode、0600、包的start/status成功、target目录符号链接可解析、stop不停止ERP，以及拒绝伪造marker路径/多行/符号链接、私有Socket替换和公开Socket符号链接/其他inode文件；Windows跳过Linux真实Socket项。首次真实安装后仍需验证包用户可读取`/proc/net/unix`及路径映射，不能凭结构测试宣称NAS已验收。
