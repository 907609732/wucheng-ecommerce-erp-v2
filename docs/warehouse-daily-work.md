# 菜鸟云仓：每日同步、员工签到与催办

本次范围为菜鸟云仓模块。先由软件策划核对业务规则，再由交互设计师完成布局，随后实现与隔离验收。没有改动采购、销售台等业务模块，没有替换正式安装版或发送真实员工通知。

## 页面与业务规则

- 运行概览上方显示采集、校验入库、钉钉群受理三步。只有当天采集、有文件摘要、校验批次和库存内容指纹匹配、群接口明确受理，才显示今日完成。
- 业务日及截止时间使用北京时间。菜鸟日报通常在次日发布上一业务日结算数据，默认要求来源日期至少达到上一业务日；页面分别显示当天日期、最新结算日期和实际来源日期。来源日期过旧、未来日期、历史快照补发都不能伪装成今日新采集。
- 没有严重预警时，正常每日同步发送简短摘要。详细预警沿用原规则。钉钉受理不代表群成员已阅读；超时或无有效回执保留结果未知。
- 商品库存默认按严重、紧急、关注、正常排序，同级依次按可售天数、库存、SKU排序。用户仍可操作桌面表头切换排序。
- 云仓页移除首次运行角色和运行模式表单；连接、服务器与成员权限由外层工作台的 Tailscale 设置管理。旧 Cloudflare API 监听器不再启动。

## 员工使用与管理

1. 管理员进入“签到管理”，填写员工的真实 Tailscale 登录账号、姓名、工作日、任务、截止时间和需要的渠道。名单不会自动授予工作台访问权限。
2. 员工需先成为有云仓编辑权限的工作台成员。普通编辑员工可以签到，不必获得采集任务执行权限；只读成员不能提交。
3. 员工从 Tailscale 入口本人登录，先“今日签到”，核对库存并处理预警后“确认今日任务完成”。后一步要求今日同步闭环成功并绑定当时的同步批次。
4. 本机窗口属于管理端，不能代替员工签到。管理员可看全员，普通员工只返回自己的安排和记录。
5. 自动催办默认关闭。管理员可按人手动选择渠道发送，也可明确开启截止后自动催办。关闭软件、主机停机或服务停止期间不会执行自动提醒。
6. 停用、休息日及已完成人员不催办。每天每人每渠道至多一次；失败、未知、未配置结果保留，避免重启后重复短信或电话。同日未知结果须先核对服务商记录；本版没有自动重试或强制重复拨打入口。

## 渠道配置

敏感配置仅在主机窗口设置，使用现有 Windows `safeStorage` 加密保存；远程页面不返回提醒密钥。空白密码保留旧值。

| 渠道 | 接入与必要设置 | 结果含义 |
|---|---|---|
| 邮件 | [Nodemailer](https://github.com/nodemailer/nodemailer)，SMTP主机、端口、账号、发件地址及授权密码；465使用TLS，其它配置要求STARTTLS | SMTP接受，不保证收件箱到达 |
| 钉钉 | 复用企业应用凭据与Robot Code；员工需绑定明确的User ID；使用机器人单聊批量发送接口，需相应应用权限 | 接口返回processQueryKey，不保证已读 |
| 短信 | [阿里云官方Node SDK](https://github.com/aliyun/alibabacloud-typescript-sdk)，短信服务授权、AccessKey、签名、已审核模板和手机号 | 返回OK及业务受理号，不保证手机收到 |
| 电话 | 阿里云官方语音SDK、语音服务授权、已审核TTS模板和手机号；显号按服务要求填写 | 返回OK及通话受理号，不保证接听 |

模板参数为JSON字符串键值对象，可用 `{name}`、`{date}`、`{task}`、`{deadline}`，键名必须与各自审核模板匹配。短信与语音按服务商规则计费，开发测试使用模拟发送器。

主源：[Nodemailer SMTP](https://nodemailer.com/smtp)、[阿里云短信API/SDK](https://www.alibabacloud.com/help/en/sms/getting-started/use-sms-api-or-sdks-1)、[语音SingleCallByTts](https://help.aliyun.com/en/vms/developer-reference/api-dyvmsapi-2017-05-25-singlecallbytts)。

## 数据与接口

原ERP账本增加 `warehouse_sync_runs`、`warehouse_daily_config`、`warehouse_attendance`、`warehouse_reminders`、`warehouse_daily_audit`；工作台迁移清单包含这些表，保留批次UUID和历史签到。不会生成第二份业务账本。

远程接口为 `/api/workbench/v1/modules/warehouse/daily`，以及POST `/daily/action`、`/daily/config`、`/daily/remind`。由已有网关核对Tailscale身份、CSRF、Origin、幂等标识和模块权限；模块继续验证签名、本人操作、UI通道和管理员权限。云仓自行公布新路由清单，兼容支持动态模块清单的工作台。

## 验证与上线边界

- 独立临时账本验证日期、旧来源、校验关联、快照内容变化、签到身份、去重、重启、休息日、逾期、未知发送结果及四种渠道请求格式。
- 隔离Electron验证首页、库存排序、员工保存、Tailscale连接提示与五个页面帮助，无脚本异常；本地ego浏览器用模拟数据验证员工签到、完成及管理员页面。
- 未进行真实菜鸟采集、真实群发送、SMTP投递、短信或电话外呼；未验证另一台员工设备的真实Tailscale访问；正式员工名单及通知凭据尚需管理员配置。
- 本地预览和源码完成后，正式模块仍需走现有构建、升级及业务数据备份流程。不得把模拟成功截图作为正式今日同步凭据。

常用检查：`node --test tests/warehouse-daily.test.mjs tests/warehouse-daily-http.test.mjs tests/warehouse-reminder-senders.test.mjs`、`node tests/warehouse-daily-ui.mjs`。帮助内容修改后执行 `node scripts/export-feature-help.mjs`。
