# 混合工作台采购实现交接（2026-10-30）

独立分支 `codex/hybrid-purchase`，从集成 `78c969a` 新建；此前采购分支保留，没有reset/rebase/修改中央冻结树。阅读并采用总控product目录三份hybrid-workbench contract/UX/UI规格。所有改动只在apps/purchase；没有运行测试、语法检查、构建、打包或打开业务账本，没有读取公司API密钥。以下为实现交接，非验收结果。

## 保留的人工业务面

原看板、年度/月份/日期口径/平台/类别筛选、月图/环图、全部订单、直接填单、修改退款、商品/物流/附件、表格映射/预览/入账、OCR后人工复核、供应商/地址、任务大卡、历史原件、来源核对、审计回滚及报表导出均保留。不是以聊天页替换这些功能。第一批仍使用既有领域服务与SQLite账本，不合并物理数据库。

## 月结：登录复核替代旧密码

- managed模式bootstrap和月度overview返回 `confirmationMode:'signed-review'`，保留真实adminConfigured原值，不伪造已设置密码。
- 原POST month-confirmations、confirm-batch、cancel、cancel-batch在managed模式只接受已验证签名的ui人员、sessionId、requestId；请求体必须ack:true。取消还要原因。body actor/actorId/approval/authorization/confirmed不能充当授权。
- 新confirmWithReview/confirmBatchWithReview/cancelWithReview/cancelBatchWithReview共用实际scope/version/date检查和原事务。确认仍受北京时间次月15日开放规则；取消逐项检查confirmation.version，批量先全部核对再写，任一不符整批不动。
- orders表原有锁月触发器和assertWritable完全保留。解除锁定必须显式取消，不能利用复核参数、旧密码header或直接填单绕过。
- 月结事件记录授权类型、实际actor、会话/请求、范围/版本、取消原因。AI month.confirm改用已验证中央proof，不再因未设旧密码失败；AI commit的结果版本、账本修订、签名和幂等边界未取消。
- 非Agent独立模式保持原密码流程及现有配置，不删除旧密码设置。managed页面不显示旧密码配置卡；旧密码API不对本机受控视图放开。

## 实际人员与经办归属分开

- 签名UI的personnel/session增加安全actor标签，任务中心默认显示全部任务，提供自愿的“我的经办”筛选和任务安排。真实登录人员不再显示成本机老板，也不按历史role/active裁剪共享任务或候选。
- 分派仍使用明确staffId；同名候选显示账号或ID以便区分。历史staffId和任务归属不自动改写，不通过姓名猜测映射，不新增权限管理。
- 任务事件保留真实actor_id，after_json另存actualActor和businessOperator；验收人的登录与原经办人独立。/api/tasks在managed下可明确operatorStaffId，单凭另填姓名不能冒充另一个人员。
- 请求级AsyncLocalStorage只保存安全身份元数据，避免并发请求串人；订单audit增加actor_json，和业务写入同事务保存。人工、AI的真实HTTP签名入口均进入同一上下文。订单入账、修改、批量属性、分类、补充来源、回滚均保留实际操作者；历史缺失身份不伪造回填。
- audit日志页显示实际操作者与人工/工具来源。没有历史来源姓名的新增单据用create审计中的可信标签显示录入人；已有手机/历史导入来源不覆盖。

## 精确本机签名契约（与hybrid_host接线）

`workbench-module.mjs`先校验回环、Host与既有verifyWorkbenchActor HMAC。localDesktop声明一旦存在必须为true；channel必须ui，actor.id必须windows:开头，uiOrigin必须精确等于`http://`+实际Host（含模块端口）；Origin若存在也必须相等。body或裸header不能注入身份。mobile managed验证同样识别本机声明。

仅该可信分支跳过远程/apps前缀改写和workbench-base.js注入；JSON敏感字段清洗、manifest、UI-only、审计仍保留。远程代理逻辑不变。localDesktop不能使用远程migration coordinator例外；秘密、维护、恢复、迁移和安装接口不开放。

主机组须：
1. 在全部同模块页面、API、静态资源请求上签发上述method/path绑定的30秒claims，不只给首次HTML签名；uiOrigin须来自当前Beta registry端口。
2. 页面以原生WebContentsView显示/隐藏并保留实例；不要求本机页具有共享网关cookie。远程网页仍经/apps代理和网关CSRF。
3. 保留受控子页/核对页、原件下载的正确签名。旧target=_blank页面也不能脱离该身份/测试账本。
4. 保留extension-preload的`lingtuShell.open('exporter')`（或兼容实现）和dataChanged通知；跨模块目标由主机解析Beta registry，绝不落旧正式端口。无可信shell时，采购核对页明确提示从更多业务打开，不再把仅返回route当成已打开。

## 人工保存幂等

managed UI JSON正式写入携带Idempotency-Key；原api wrapper添加UUID，手机使用既有提交UUID。新增workbench_manual_receipts以真实actor+key持久化路径/输入摘要和实际响应。相同键/相同输入回读；不同输入拒绝；processing或进程崩溃后的未知结果拒绝盲重放，必须核对原业务记录。只读GET `/api/manual-receipts/:key`查询当前真实人员的提交回执。

这里没有把异步或崩溃边界伪称为原子成功：业务写后、响应登记前崩溃会留下processing，由实际账本回查处理。multipart表格/OCR只做暂存/识别，正式JSON入账才走此回执；AI原有prepare/commit/receipt独立保留。

## remote:false逐项处理

| 原页面接口 | 本轮处理 |
| --- | --- |
| /api/dashboard、orders、suppliers、supplier-management、addresses、task-board、tasks、month-confirmations及导入/OCR/附件/报表 | 原manifest已允许的真实业务接口继续使用，未新增总闸绕过 |
| GET /api/app-info、/api/bootstrap、/api/health | 公开业务状态沿用；managed bootstrap需要真实签名且剔除本地token；health用于服务探测 |
| /api/admin/password | 不放开；managed改用登录复核，不再需要该接口 |
| /api/mobile-admin/* 与 /phone | 不放开；managed手机页使用/mobile.html及已登记/api/mobile/*；状态提示不再探测旧独立Serve配置 |
| /api/backup、恢复、更新、维护、迁移 | 不放开；采购页面说明由工作台统一处理，不提供会失败或可能替换正式组件的操作 |
| GET /api/manual-receipts/:key | 新增明确只读manifest条目，不开放任意路径或整组settings |

## 尚待主组收敛与集中验收

- 主机真实Windows登录、签名注入、主壳导航/bounds/视图保留、远程HTTPS与cookie/CSRF、原件及弹出核对页都需实际验证；源码接线不代表已可用。
- 持久草稿恢复、退出/重连草稿保护、受控record/source定位、页面范围交给AI的统一桥协议仍需主机/UX/UI契约。本轮保留现有内存表单与原人工功能，不虚称实现跨退出草稿恢复，也未让模型读取未提交表单。
- 测试仅在现有workbench-gateway、audit-log、month-locks文件补充新行为用例，尚未运行。最终统一验收应包含无旧密码月结/取消、批量回滚、锁月、签名伪造/Origin不符、原单人机修改审计和并发不串人，以及完整包内人工录单。
- 修改了source/manifest，覆盖摘要和正式stage须在总控C源码窗口重新生成。未触主干、中央冻结树、正式数据或Serve/密钥配置；安装器仅由总控生成，不做便携包。
