# 工作台接口与迁移约束

业务仍由本模块服务持有 SQLite、原件和附件。独立 localhost 页面及既有写入校验保留。

## 网关

- 页面入口：`/apps/<module>/`；浏览器请求沿此入口访问 `/apps/<module>/api/...`，保留模块核对 Cookie。
- CLI/MCP 入口：`/api/workbench/v1/modules/<module>/<原接口路径>`。不能代替界面的确认会话。
- 服务身份响应 `workbench.protocolVersion=1`；`GET /api/integration/v1/workbench/operations` 返回逐接口分类。`workbench-manifest.json` 是已审核的允许清单；新增 API 默认禁止远程使用。修改接口后在隔离数据上运行 `node scripts/workbench-manifest.mjs`，审核清单差异。
- 原始 `/api/integration/v1/capabilities` 仅主机本地可读，包含持久化 `dataSetId` 和 `revision`。账本 UUID 保存在 SQLite；业务表触发器随成功事务增加版本，覆盖独立脚本、桌面和手机写入。版本计数不进入迁移确认的业务快照摘要。
- 代理必须来自本机回环，使用 `.workbench-key` 签署 `X-Workbench-Actor`（base64url JSON）。签名为对该编码字符串的 HMAC-SHA256。身份绑定模块、方法、原 URL、时效、用户及会话；原站点 Bearer 与页面核对会话继续独立。
- 页面随机写入 token 不返回客户端；网关已验证用户、来源及 CSRF 后，模块接受签名身份。核对 nonce/Cookie 另外绑定同一用户及工作台会话。CLI/MCP 不可提交界面确认。
- 备份恢复、停服务、密码、手机入口配置、浏览器授权及打开主机文件夹仅允许主机本地管理。日志记录用户身份、接口与结果，不记录请求凭据。

采购原有 443 手机入口仍保留配对和 CSRF。设置 `LINGTU_WORKBENCH_POLICY_FILE` 后，额外校验可信 Serve 回环、原配置主机名、`Tailscale-User-Login` 及统一权限文件；未授权身份拒绝访问，查看者不能修改业务。配对会话绑定同一 Tailscale 用户，策略每次请求重新读取。策略文件缺失或损坏不会退回无权限检查模式。

## 内部迁移协调器

所有迁移 HTTP 接口均位于 `/api/integration/v1/workbench/migration`，在公开清单中为 `remote:false`。调用须同时具备本机集成 Bearer、签名管理员 UI 身份；不开放通用远程提交。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/export` | 业务记录和只读历史证据快照；包含本机文件描述，不能公开转发 |
| GET | `/files/:id` | 按导出清单读取并复核指定原件 |
| POST | `/preview` | `{bundle,selections?}`，差异、锁定检查、分账本/月/币种金额核对及预留 ID |
| POST | `/maintenance` | `{enabled,migrationId}`；忙碌检查，按批次持有的维护标志跨重启保留 |
| POST | `/backup` | 维护期间生成一致性 SQLite 备份，返回路径、字节数与 SHA256 |
| POST | `/commit` | `{plan,permit}`，维护与两次确认凭据验证、原有业务校验、事务和逐记录回读 |
| GET | `/verify/:id` | 提交后再次读取已记录业务字段，列出差异 |
| POST | `/restore` | 拒绝在线覆盖数据库；须协调器停服务后验证并恢复备份 |

模块工厂 `createWorkbenchMigration(store, options)` 提供同名导出、预览、提交及复核方法。`canCommit` 默认拒绝；`resolveFile(id,descriptor)` 只能返回受控暂存的 Buffer，模块再次核对大小及摘要。HTTP 暂存路径为 `<dataDir>/workbench-migration-staging/<stagingId>`，不接受客户端任意文件路径。提交 `plan={migrationId,bundle,revision,selections}` 必须属于当前维护批次，文件准备后、事务开始前会再次核对许可。其他批次不能抢占或释放维护；同批次的签名管理员可恢复，初始持有人身份仍保留审计。每次请求重新读取持有标志，外部写入的旧客户端冻结标志立即生效。

快照为 `{schemaVersion:1,module,sourceInstance,records}`。记录为 `{kind,sourceId,payload,files}`；每条选择 `{kind,sourceId,action:'add'|'skip'|'update',fields:{字段:'existing'|'incoming'}}`。保留原值为默认选择，禁止空白覆盖。预览和提交都校验目标版本、锁定月份与业务约束。

账本身份是 SQLite `workbench_identity` 中持久化随机 UUID；不同电脑相同目录不会共享身份。预览返回 `plannedTargetId/plannedIdMap`，提交必须使用相同目标 ID。店铺只按已核对的平台与名称对应，不按客户端原始 ID 推断。图片资产使用已验证内容摘要，图片关联使用原有来源键；保留缓存完整文件和缩略图，离线仍可读取。

总览通过 `bundle.references` 对应采购/销售及店铺 ID；`plannedSources/plannedShops` 仅用于预览本批依赖，正式写入必须重新验证实际源账本。来源快照及派生对应关系都应进入两次确认摘要。金额以整数分、账本、统计口径、月份及币种分别核对，未知金额单列。

迁移许可：`permit={digest,expiresAt,signature}`，`digest` 为递归排序对象键（保留数组顺序）的 plan JSON 的 SHA256。签名内容为 `workbench-migration/v1:<digest>:<expiresAt>:<actor.sessionId>`，有效期最长 60 秒。原始审计、锁定快照与采集来源只作为不可修改证据，不恢复旧会话、密钥或确认收据的执行权限。

完全重复的记录可在锁定月份安全跳过；新增附件、金额或其他业务变更仍执行原锁定规则。订单附件与图片资源独立迁移，同一订单存在时仍能追加新附件。采购补充来源、销售匹配与汇率、总览分类及退款日期保留功能上的来源关联。未提交导入草稿、作废账单和撤销付款仅保留只读档案，不在新账本恢复执行权。多次迁移继续携带历史档案的原始来源和实际文件，保留业务金额并移除凭据。

导入流水冲突、已匹配销售流水的更改、锁定月份的新写入及重叠运费继续要求所属业务原流程处理。整批失败回滚本模块事务并清理新文件；跨模块回滚由主协调器在维护期间停服务后恢复已验证备份，不能在线覆盖打开的数据库。
