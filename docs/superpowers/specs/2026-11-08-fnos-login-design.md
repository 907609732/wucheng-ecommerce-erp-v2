# 飞牛登录与 FN Connect ERP 入口

## 用户目标与已选方案

用户要求能复用飞牛登录就直接接好，以飞牛中转为日常入口、保留 Tailscale 备用；普通 Docker 端口无法复用时评估封装应用。用户已明确要求直接执行，方案按实测结果选定，不再重复询问同一选择。

实机 fnOS 1.2.0604、管理员账号907609732。独立FPK探针证明统一网关传递 UID1000、username、isadmin=true，Unix peer UID0；伪造X-Trim头被覆盖，未登录请求返回invalid token而非身份数据。普通端口不具备此身份契约。采用官方统一网关薄FPK，继续复用现有Docker唯一运行时和账本；不迁移至虚拟机，不启动第二套ERP。

官方依据：https://developer.fnnas.com/docs/core-concepts/gateway-registration/ 、/app-entry/ 、https://developer.fnnas.com/docs/examples/docker/ 。官方fnpack1.2.3用于打包。FPK appname=wuchengerp，gatewayPrefix=/app/wuchengerp，gatewaySocket=app.sock。

## 接入设计

- 同一ERP进程、services、状态库、数据版本worker增加独立Unix HTTP listener。原TCP入口仅接受原Tailscale身份；不得信任TCP上的X-Trim字段。两个入口共用现有审计、签名actor、幂等、维护排空、月锁及数据集绑定。
- listener内部标记请求来源，不能凭header或空remoteAddress判定Unix。Unix路径必须显式配置，socket0600、由ERP用户所有且不可组/全局写的物理父目录，不覆盖既有文件/活动socket；部署时只有ERP与root官方网关可以连接。经过同UID、同inode检查及连接被拒绝证明已失效的旧socket可受控清理，以支持异常退出重启。
- fnOS配置默认关闭。开启需明确instanceId、socketPath、固定basePrefix、allowedOrigins及allowedUids；初次仅授权已实测UID1000。UID稳定用于身份；username仅显示。fnOS管理员标记不自动授予未授权UID访问ERP。
- 主体fnos:{instanceId}:{uid}与tailscale:{login}隔离。旧会话/成员/审计兼容迁移；会话绑定provider-qualified主体，fnOS使用独立cookie并限定应用路径，每次请求仍经NAS登录态验证。
- 固定允许源包括实测FN Connect HTTPS源；局域网入口可显式配置当前NAS HTTP源，HTTPS外网不得降级。Host仅接受已配置源的精确host或经实测NAS转发移除端口后的hostname；Origin仍严格匹配配置，每次写入要求正确Origin及CSRF。
- 在Unix入口剥离准确basePrefix后交给同一路由器，公开资源/API/跳转/cookie带回该前缀。模块公共前缀通过已签名actor声明传递，不信任未签名转发头。对编码斜线/点路径/错前缀明确拒绝。
- FPK只注册飞牛入口和状态检测，不管理Docker daemon、不接触账本、不停止ERP。启停或卸载飞牛入口不破坏Tailscale。安装/配置/恢复脚本不得创建新空账本或使用通配删除。
- 私有固定绑定名.app.sock.listener保留，app.sock通过同inode硬链接发布；FPK解析TRIM_APPDEST物理路径并校验二者同inode及私有监听记录。fnOS监听运行故障降级并记录状态，不能停止已启动的Tailscale备用入口。飞牛shell只允许同源桌面iframe；Tailscale shell继续禁止被嵌入。

## 页面体验

登录飞牛，点击“五成ERP”，无需再次输入ERP账号密码。显示真实飞牛用户名；采购、销售、运费、经营总览、数据版本与现有功能一致。管理员解锁密码仍按原业务规则验证。

## 验收与切换

先隔离数据验证Unix真实传输、伪造头/重复头/未授权UID、身份改名不变、旧Tailscale回归、两入口同数据集和单owner、子路径三模块页面/API/附件下载/上传/CSRF/锁定。只在合成账本做写操作。独立审阅后推送GitHub检查及NAS镜像构建；停写备份并恢复验证后切换现有唯一Docker实例，保留所有实际挂载及回滚配置。正式只读验证三模块报表摘要、版本队列和身份。FN Connect实际中继与LAN自动直连分开记录，不用局域网成功冒充公网验收。

## 未决实测

FN Connect最终HTTPS域名、转发的Host/Origin契约及中继登录状态尚需捕获验证。普通用户/登出测试不得擅改用户现有NAS账号；用隔离测试或用户实际账号协作完成。若受系统约束不能证明可靠认证，保持旧入口并报告限制，不能固定伪装管理员。
