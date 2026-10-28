# 销售台 Agent 能力与验证证据

下表按模块内部实际声明逐项列出 **75 项：查询 44、人审准备 24、免审准备 7**。中央公开目录将第 69 项内部 `sales.file-stage` 替换为 `sales.files.stage {attachmentId}`，总数不增加；中央公开文件字段只接受 `{id}`。Schema 的有效样例只证明契约可编译，不独立作为业务成功证据。

表中“签名 HTTP”是测试临时 localhost 服务、真实工作台人员 HMAC、真实销售领域函数及临时 SQLite，不是模拟 transport。测试使用合成业务原件，避免读取或修改正式数据。菜鸟外部浏览器和 CBR 网络响应的替身另行明确。

## 证据索引

| 编号 | 测试文件及用例 | 实际验证范围 |
| --- | --- | --- |
| H1 | [agent-http.test.mjs](../test/agent-http.test.mjs) `central review books real compensated freight exactly once, persists receipt and rejects unsigned/forged/crossactor/stale writes` | 实际补偿运费 84389 分、中央审批、附件 SHA、无审批/伪造/跨人员/过期修订拒绝、重放与重启后回执 |
| H2 | 同文件 `employee expense/manual receivables operate with actual permissions; financial review and privilege injection fail` | 真实员工手工销售/退款/费用与应收范围；老板资金能力拒绝、内部确认字段注入拒绝 |
| H3 | 同文件 `real file mapping preview commits operations with source retained; duplicate skips and month-lock guards remain` | 实际 CSV 列映射、隔离预演、提交后记录、原件字节、去重及锁月拒绝 |
| H4 | 同文件 `managed sources and nonreview backup expose owned hash-checked downloads without business writes` | 同人员同任务原件暂存及列检查、跨人员拒绝、真实备份 ZIP 下载 SHA、员工备份权限 |
| H5 | 同文件 `reviewed shop and ledger lifecycle, coverage, month unlock and restore copy persist verified receipts` | 店铺及手工流水增改删、覆盖、锁月/解锁、已验证备份恢复到独立 SQLite 副本与实际回执 |
| H6 | 同文件 `adapter uses only frozen trusted transport and exact module APIs, propagating approval out of model input` | transport 契约及审批位置；该项为边界单测，不代替领域执行 |
| H7 | 同文件 `host attachment ID flows through real chunk HTTP, reviewed import and registered central result download` | 真实任务附件由可信 resolver 读取、签名分片 HTTP、暂存 ID、人审导入 4250 分；真实导出 HTTP 字节保存在中央 taskDir 并 registerArtifact，模型未取得模块 URL |
| H8 | 同文件 `sales host uploads a real 50MiB attachment with persisted resume after restart and rejects oversized files` | 销售台实际 50MiB 文件、断线及服务重启后仅补剩余 49 片、完整摘要、重复上传同 ID、超限拒绝 |
| X | [overview/tests/agent-files.test.mjs](../../overview/tests/agent-files.test.mjs) 的 3 个用例 | 共享主机/服务协议：真实分片与重启、人员/任务/大小/摘要绑定、完整 50MiB 与超限/路径/整体 SHA 拒绝，以及 ID-only 适配器及中央 artifact 登记；属于共享桥接证据，不替代销售业务断言 |
| C1 | [agent-capabilities.test.mjs](../test/agent-capabilities.test.mjs) `authenticated query capabilities read real official statements, movements, originals, reports and exported files` | 合成官方格式淘宝 CSV、拼多多 ZIP 经签名 HTTP 人审导入；逐项查询；资金 10000 分、逐笔 2 条、真实原件/附件/Excel/模板字节及 SHA |
| C2 | 同文件 `reviewed matching, freight correction/void, import rollback and PDD reference persist domain records` | 结算收款匹配 10000 分及撤销；运费改版、过期版本拒绝及作废；批次撤销留原件；拼多多整数分参考入库 |
| C3 | 同文件 `monthly job produces a downloadable actual report; job and staff handoff preconditions reject unsafe states` | 月报真实 needs_action、实际 XLSX 下载、任务列表、互斥拒绝；交接角色/过期/未就绪拒绝 |
| R1 | [agent-remaining.test.mjs](../test/agent-remaining.test.mjs) `skill query returns the packaged actual guide and keeps merchant and SF collection unavailable` | 签名员工查询实际发布的 3 份指引原文；merchant/sf 自动采集明确不可用 |
| R2 | 同文件 `batch attribution crosses real central review while preserving every ledger row and original byte` | 拼多多取消与重新确认归属均经签名 HTTP 人审；行 ID/金额/批次和原 ZIP 字节保持、待归属状态正确 |
| R3 | 同文件 `rates refresh parses mocked official CBR XML and commits fixed-point rates through central review` | 仅官方网络被 mock；真实 XML 解析、隔离预演、审批、3 条固定精度汇率入库、来源 SHA、回执重放 |
| R4 | 同文件 `ready employee handoff persists actual employee identity and reviewed receipt without approving funds` | 完整准备资料后员工真实 HTTP 人审交接成功，人员及 staffRevision 落库；不自动确认资金或锁月 |
| R5 | 同文件 `current-month cutoff reaches the real Cainiao domain through signed HTTP and cannot include today` | cutoff 与 cutoffs 两种形态通过 Schema 后由实际领域拒绝今天，不访问平台、不创建下载任务 |
| S | [agent-schema.test.mjs](../test/agent-schema.test.mjs) | 所有 75 项 Schema 编译、中文说明、有效样例；额外字段、金额、日期、分页、文件及费用约束；中央公开文件 Schema 不暴露 Base64；不视为业务链路 |
| T1/T2 | [agent-transaction-isolation.test.mjs](../test/agent-transaction-isolation.test.mjs) `async Agent owner isolates other actors and jobs; rollback=false/true` | SQLite 实际异步事务、他人/后台任务/prepared/raw DB 写入阻断，提交和回滚分别验证 |
| T3 | 同文件 `failed BEGIN releases owner and detached callbacks cannot write after commit` | 实际 SQLite BEGIN 失败后释放所有权、分离回调不能在提交后继续写 |
| K1 | [agent-cainiao.test.mjs](../test/agent-cainiao.test.mjs) `真实ZIP/XLSX：自动下载、原件归档、费用分类和可人审运费草稿完整链路` | FakeBrowser 外部替身；真实 ZIP/XLSX 解析归档、97000 分分类、原件 SHA、预览不入账、重复阻断；此用例后半直接调用领域保存，不冒充中央审批 |
| K2 | 同文件 `未知费用、负快递费、非CNY、金额精度和净额不平均阻断，原件仍归档` | 5 类异常分别阻断，原件保留且业务表不变 |
| K3 | 同文件 `月份锁定、原件被改动、页面实际日期不符均不能进入入账草稿` | 锁月、归档被改动、模拟平台实际日期与请求不同均阻断 |
| K4 | 同文件 `运行中停止保留已下载原件，恢复继续；提交不明先找旧任务避免重下` | 真实任务状态/原件存储、停止/继续，模拟平台不明确提交后先复用旧任务 |
| K5 | 同文件 `当前月必须保存截止日且最多到北京昨天，分类要求截止范围一致` | 领域接口实际校验截止日及归档范围；月初无可用日期时明确 skip |
| K6 | 同文件 `未结月只更新已核实同源记录，保留ID/version与旧附件历史，缩小范围阻断` | 真实未结更新的 ID/version/旧附件历史与覆盖缩小拒绝；本月不足两个截止日时 skip |
| K7 | 同文件 `任意已验证历史月启用多月，不硬编码2026-09；ZIP路径及缺分卷阻断` | 已验证历史月份解锁多月能力、ZIP 越界和缺少交易/货品证据拒绝 |
| K8 | 同文件 `真实签名HTTP：后台下载→原件预览→中央人审→入账/附件SHA/回执重放；无审批与重复均拒绝` | FakeBrowser 提供平台结果；签名 HTTP 状态/任务列表与连接/断开；下载、原件查询、中央审批、正式运费保存 97000 分/other=-5000 分、3 个附件逐个 SHA、无审批/重复阻断、回执幂等；子测试实际通过 cutoff/cutoffs 下载当前月，回读 job 范围及 interim/cutoff 且不提前入账 |

## 75 项逐项对应

简写：M=`YYYY-MM`，D=`YYYY-MM-DD`，P=与 grain 对应的日/月/年；file=同人员同任务原件 `{id}`（内部传输另兼容原名+Base64+SHA）。所有编号从实际查询结果取得，不使用路径。金额单位在各项中单独说明。

| # | 内部能力 ID | 中文名称 | 类型 | 输入业务口径 | 对应执行证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | `sales.shops` | 查询店铺列表 | 查询 | `{}` | C1 签名 HTTP 返回店铺数据 |
| 2 | `sales.task-center` | 查看月度任务 | 查询 | `month:M` | C1；R4 真实就绪/交接状态与 staffRevision |
| 3 | `sales.manual-summary` | 查看手工渠道应收 | 查询 | `month:M, shop?` | C1 签名读取；H2 员工手工应收实际权限 |
| 4 | `sales.sources` | 查看店铺数据覆盖 | 查询 | `month:M` | C1 签名读取覆盖摘要 |
| 5 | `sales.history-coverage` | 查看历史覆盖进度 | 查询 | `{}` | C1 签名读取历史覆盖 |
| 6 | `sales.report` | 查看经营月报 | 查询 | `period:P, grain?:day/month/year, shop?, empty_trend?:skip` | C1 实际账单后查询；H2 员工拒绝 |
| 7 | `sales.reconciliation` | 查看结算收款匹配 | 查询 | `month:M, shop?` | C1 真实摘要；C2 实际匹配数据 |
| 8 | `sales.ledger` | 查询业务流水 | 查询 | `month:M, shop?` | C1；H2 实际员工手工业务 |
| 9 | `sales.imports` | 查看导入批次 | 查询 | `{}`，当前最多 200 批 | C1 真实导入批次后查询 |
| 10 | `sales.original` | 下载导入原件 | 查询 | `id:批次ID` | C1 原字节完全一致；C2 撤销后仍可取 |
| 11 | `sales.file-inspect` | 检查报表列名 | 查询 | `file, sheet?, header_row?:1..100` | H4 真实暂存原件及列检查；S 路径/范围拒绝 |
| 12 | `sales.taobao-funds` | 查看淘宝资金汇总 | 查询 | `shop_id, period:P, grain?` | C1 实际官方格式导入后收入=10000 分 |
| 13 | `sales.taobao-statement` | 查看淘宝年度月表 | 查询 | `shop_id, year:YYYY字符串` | C1 实际年度月行收入=10000 分 |
| 14 | `sales.taobao-movements` | 查询淘宝逐笔流水 | 查询 | `shop_id, month?/from?/to?, q?, direction?, category?, batch_id?, sort?, sort_dir?, page>=1, page_size:50/100` | C1 实际逐笔总数 2；S 分页边界 |
| 15 | `sales.taobao-movement` | 查看淘宝流水原文 | 查询 | `shop_id, id:真实流水ID` | C1 查询返回同条流水 ID |
| 16 | `sales.taobao-export` | 导出淘宝筛选流水 | 查询 | 同逐笔筛选，不接受分页、导出完整筛选范围 | C1 实际 XLSX 下载及 SHA |
| 17 | `sales.pdd-funds` | 查看拼多多资金汇总 | 查询 | `shop_id, period:P, grain?` | C1 实际官方 ZIP 导入后收入=10000 分 |
| 18 | `sales.pdd-statement` | 查看拼多多年度月表 | 查询 | `shop_id, year:YYYY字符串` | C1 实际年度月行收入=10000 分 |
| 19 | `sales.pdd-movements` | 查询拼多多逐笔流水 | 查询 | 同淘宝筛选；`attribution:unassigned` 时必须有 batch_id，可省 shop_id | C1 正式逐笔 2 条；R2 待归属可查询；S 条件约束 |
| 20 | `sales.pdd-movement` | 查看拼多多流水原文 | 查询 | `id, shop_id` 或 `id, attribution:unassigned, batch_id` | C1 正式单条原文；S 待归属形态 |
| 21 | `sales.pdd-export` | 导出拼多多筛选流水 | 查询 | 同拼多多筛选，不接受分页 | C1 实际 XLSX 下载及 SHA |
| 22 | `sales.pdd-unassigned` | 查看拼多多待归属账单 | 查询 | `{}` | R2 取消归属后真实批次出现在列表 |
| 23 | `sales.freight-report` | 查看运费汇总 | 查询 | `period:P, grain?, shop?:all/shared/ID, channel?:all/warehouse/merchant/sf` | C1 实际运费后查询 |
| 24 | `sales.freight-records` | 查询运费明细 | 查询 | 汇总范围加 `status?:active/all,page>=1,page_size:25/50/100` | C1 真实记录列表；S 分页 |
| 25 | `sales.freight-record` | 查看单笔运费 | 查询 | `id:运费ID` | C1 实际保存记录后读取 |
| 26 | `sales.freight-attachment` | 下载运费原件 | 查询 | `id:附件ID` | C1/H1/K8 真实字节及 SHA |
| 27 | `sales.freight-export` | 导出运费台账 | 查询 | 运费汇总范围，`status?:active/all` | C1 实际 XLSX 下载及 SHA |
| 28 | `sales.close-preview` | 检查月份锁定预览 | 查询 | `month:M`，返回最新 revision | C1 实际锁月领域预览；H5 使用修订锁月 |
| 29 | `sales.close-history` | 查看锁定修订历史 | 查询 | `{}` | C1 签名 HTTP 读取；H5 真实锁/解锁记录 |
| 30 | `sales.audit` | 查看业务审计 | 查询 | `{}` | C1 真实导入/运费后的审计查询 |
| 31 | `sales.jobs` | 查看月报生成任务 | 查询 | `{}` | C3 实际生成后列表包含任务 |
| 32 | `sales.job-report` | 下载已生成月报 | 查询 | `id:任务ID` | C3 实际 XLSX 字节及 SHA |
| 33 | `sales.report-history` | 查看历史月报状态 | 查询 | `{}` | C3 实际生成月报后签名查询 |
| 34 | `sales.export` | 导出经营与对账Excel | 查询 | `period:P, grain?, shop?` | C1 实际工作簿下载及 SHA |
| 35 | `sales.template` | 下载业务导入模板 | 查询 | `type:operations/ledger` | C1 实际 CSV 模板含 start 表头；S 枚举 |
| 36 | `sales.backups` | 查看一致性备份 | 查询 | `{}` | C1 真实提交备份后列表非空 |
| 37 | `sales.backup-verify` | 验证备份完整性 | 查询 | `name:已登记安全备份名`，不接受路径 | C1 实际备份返回 ok=true；S 路径拒绝 |
| 38 | `sales.rates` | 查看已保存汇率 | 查询 | `{}`，返回固定精度及来源 | R3 实际入库后查询 3 条 |
| 39 | `sales.skill` | 读取云仓运费操作指引 | 查询 | `{}` | R1 实际发布的 3 份文件原文和平台可用状态 |
| 40 | `sales.cainiao-status` | 查看菜鸟连接状态 | 查询 | `{}` | K8 签名 HTTP 状态；外部连接为 FakeBrowser |
| 41 | `sales.cainiao-jobs` | 查看菜鸟账单任务 | 查询 | `{}` | K8 签名 HTTP 已下载任务列表 |
| 42 | `sales.cainiao-job` | 查看菜鸟任务详情 | 查询 | `jobId` | K8 签名 HTTP completed 与受控原件标识 |
| 43 | `sales.cainiao-preview` | 预览云仓月账费用 | 查询 | `jobId, month:M` | K8 97000 分、无 Base64；K1–K7 来源/分类/日期/锁月边界 |
| 44 | `sales.cainiao-file` | 下载菜鸟账单原件 | 查询 | `fileId:任务实际返回的文件ID` | K8 签名下载原 ZIP，SHA 等于归档原件 |
| 45 | `sales.shop-create` | 登记真实店铺 | 人审 | `platform:淘宝/拼多多/京东/闲鱼/抖店/Ozon/线下/代发, name` | H5 中央人审后真实店铺及回执 |
| 46 | `sales.shop-delete` | 删除无记录店铺 | 人审 | `id, name:须与实际店名一致` | H5 真实无记录店铺删除 |
| 47 | `sales.ledger-create` | 登记业务流水 | 人审 | `shop_id,date:D,kind,amount:原币元字符串,external_id`；可选 currency/source/match_key/order_ref/category/deducted/note | H2/H5/C2 实际手工及结算收款入库；元→分 |
| 48 | `sales.ledger-update` | 更正手工流水 | 人审 | `id,date:D,amount:原币元字符串,currency`；可选 match_key/order_ref/category/deducted/note/reason | H5 实际更正及回读；S reason 契约 |
| 49 | `sales.ledger-delete` | 删除手工流水 | 人审 | `id, reason` | H5 实际删除、审计与回执 |
| 50 | `sales.match-create` | 核对结算与实际收款 | 人审 | `left_id,right_id,left_amount/right_amount:各自原币元字符串,reason` | C2 实际 matches 保存 10000 分；H2 员工拒绝 |
| 51 | `sales.match-delete` | 撤销资金匹配 | 人审 | `id, reason` | C2 实际删除匹配且回读确认 |
| 52 | `sales.coverage` | 登记数据核对结果 | 人审 | `shop_id,month:M,dataset:operations/settlement/receipt/expense,status:missing/partial/full,evidence` | H5 实际覆盖保存；H2 员工不能确认资金范围 |
| 53 | `sales.import` | 导入实际业务报表 | 人审 | `file, context{shop_id,month:M,dataset:operations/ledger,sheet?,header_row?}, options{mapping,source,definition?,compatible?,default_kind?,default_currency?}`；运营必有口径 | H3 实际映射/去重/锁月；C2 撤销；原始列号从 0 开始 |
| 54 | `sales.taobao-import` | 导入淘宝官方货款 | 人审 | `shop_id,file`；保留同月官方中文 CSV 名 | C1 实际官方格式 CSV 导入、两条记录及原字节 |
| 55 | `sales.pdd-import` | 导入拼多多官方账单 | 人审 | `shop_id:真实店铺或__unassigned__,file:官方ZIP` | C1/R2 实际 ZIP、尾部笔数/金额及归属记录 |
| 56 | `sales.import-rollback` | 撤销已导入批次 | 人审 | `id:导入批次,reason` | C2 已入库运营数据删除、批次 rolled_back、原件保留 |
| 57 | `sales.batch-attribution` | 确认账单所属店铺 | 人审 | `id,status:confirmed/unassigned,reason`；confirmed 必有 shop_id | R2 两方向真实人审成功，原行/原件保持 |
| 58 | `sales.pdd-reference` | 登记平台截图对照 | 人审 | `shop_id,month:M,cutoff:本月D 23:59:59`；收/支/余额为整数分或 null，笔数整数，可选 file/evidence_name/note | C2 实际 expense=-100、closing_balance=9900；不生成资金匹配 |
| 59 | `sales.freight-create` | 登记运费及赔付抵扣 | 人审 | `channel,entry_mode,period,shipping:元字符串`；其他费用元字符串、other_note、单号及 files<=5；负赔付保留 | H1 84389 分含赔付；K8 97000 分含负 other；附件 SHA |
| 60 | `sales.freight-update` | 更正运费记录 | 人审 | 同新增加 `id,version`，可选 remove_attachments | C2 实际更正后总额=12400 分，过期 version 拒绝；K6 保留历史 |
| 61 | `sales.freight-void` | 作废运费记录 | 人审 | `id,version,reason` | C2 实际 status=void、回读及回执 |
| 62 | `sales.month-lock` | 确认并锁定月份 | 人审 | `month:M,revision:最新锁月预览SHA` | H3/H5 真实锁月及后续写入拒绝 |
| 63 | `sales.month-unlock` | 明确解锁历史月份 | 人审 | `month:M,reason` | H5 实际解锁并保留历史 |
| 64 | `sales.rates-refresh` | 补齐官方参考汇率 | 人审 | `month:M`，根据实际外币业务日期请求 | R3 XML 解析/预演/审批/固定精度/来源 SHA；CBR 网络为 mock |
| 65 | `sales.job-create` | 检查并生成月报 | 人审 | `period:M` | C3 真实 needs_action 任务及 XLSX，互斥拒绝重复任务 |
| 66 | `sales.staff-handoff` | 提交资料等待老板 | 人审 | `month:M,revision:当前staffRevision`，必须真实员工 | R4 真实就绪提交、人员/指纹/回执；C3 角色/过期/未就绪拒绝 |
| 67 | `sales.backup` | 创建并验证备份 | 免审准备 | `{}` | H4 真实 ZIP、摘要验证与下载，不修改正式业务数据 |
| 68 | `sales.restore-copy` | 恢复备份为独立副本 | 人审 | `name:已登记备份名` | H5 实际恢复独立 SQLite 副本并回读，不覆盖正式账本 |
| 69 | `sales.file-stage` | 暂存任务原件 | 免审准备 | 内部 `file{filename,dataBase64,sha256}`；中央替换为 `sales.files.stage{attachmentId}` | H4 内部暂存与归属；H7 公开附件→人审入账/任务下载；H8/X 50MiB 与续传；S 不允许模型 Base64 |
| 70 | `sales.cainiao-connect` | 连接菜鸟云仓 | 免审准备 | `{}` | K8 实际能力 HTTP prepare；外部浏览器为 FakeBrowser |
| 71 | `sales.cainiao-disconnect` | 断开菜鸟连接 | 免审准备 | `{}` | K8 实际能力 HTTP prepare；外部浏览器为 FakeBrowser |
| 72 | `sales.cainiao-download-start` | 逐月下载菜鸟账单 | 免审准备 | `account,from:M,to?:M,cutoff?:D,cutoffs?:{M:D},force?:boolean`；本月截止不得晚于北京昨天 | K8 历史/当月两种截止形态真实 HTTP→归档/范围回读；K5 当月边界；R5 实际领域拒绝今天 |
| 73 | `sales.cainiao-download-stop` | 停止菜鸟下载 | 免审准备 | `jobId` | K4 实际任务停止、已下载原件保留 |
| 74 | `sales.cainiao-download-resume` | 继续菜鸟下载 | 免审准备 | `jobId` | K4 实际任务恢复、不明确提交后避免盲重下 |
| 75 | `sales.cainiao-posting` | 复核云仓运费入账 | 人审 | `jobId,month:M`；提交时重验 sourceFingerprint | K8 真签名 HTTP、无审批拒绝、正式保存/附件/回执、重复不入账；K2–K7 阻断 |

## 验证命令与证据限制

在 `apps/sales` 下按需运行：

```powershell
node.exe --test test/agent-http.test.mjs test/agent-capabilities.test.mjs
node.exe --test test/agent-schema.test.mjs test/agent-remaining.test.mjs
node.exe --test test/agent-transaction-isolation.test.mjs test/agent-cainiao.test.mjs
```

以上是可复现命令，表格记录用例中实际执行的断言，不能将列出的命令视作某次全部运行通过的日志。S 类 Schema 样例、H6 transport 替身与菜鸟 FakeBrowser 各自有明确层次；它们不代替本地 HTTP、数据库回读、原字节验证，更不等于真实平台浏览器验收。R3 的官方网络响应也为 mock。

2026-10-28 的本次定向复核：`agent-schema.test.mjs` 与 `agent-remaining.test.mjs` 合计 **11/11 通过**；菜鸟负责人复核 `agent-cainiao.test.mjs` **14/14 通过、0 skip**（含嵌套用例，提交 `31f2b10`）。主代理另已核实 H7、H8 及共享 X 的成功结果。此处分别记录执行批次，不合并成虚构的全套总数。

中央主机增量由 H7、H8、X 单独提供附件/分片/任务 artifact 证据，不使用 H4 的旧 25MiB inline 入口代替。H7 实际读取并保存 HTTP 字节、核验 SHA 并登记；其测试 transport.download 是专门测试桥接实现，不证明任意第三方宿主已接入同样桥接。本轮尚需真实账号完成的菜鸟外部平台边界，是使用用户当前浏览器的登录态实际查询/下载并逐项核验页面日期、笔数、金额及原件。merchant/sf 自动采集保持不可用，不列为已交付能力。

本文件不证明桌面启动器、打包安装、正式账本变更或生产发布。测试只使用 `os.tmpdir()` 隔离副本、动态端口与合成原件。
