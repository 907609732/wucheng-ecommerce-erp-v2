# 采购／导出台旧入口到 Agent 能力对应（2026-10-29）

状态：源码人工核对及补实现，**不是统一验收通过清单**。未运行本轮测试、真实平台或真实发送；正式业务账本未打开或修改。静态资源和导航不计作独立业务能力。基于合入的集成分支01b40a9之后继续，旧交接列出的五个提交已在共同历史内，不需重放。

## 采购旧入口

| 原入口／行为 | Agent能力或归属 | 关键边界 |
|---|---|---|
| 看板 /api/dashboard | dashboard | 沿用付款月／下单月及类别净支出口径 |
| 全部订单、筛选、详情 /api/orders/:id | orders | 返回真实订单ID和updatedAt；列表分页 |
| 直接录入／修改、退款、商品物流、分类分摊、附件关联 | order.create / order.update | 封闭订单schema；版本、去重、锁月；中央复核 |
| 批量采购属性 | orders.attributes | 逐单版本与锁月 |
| 批量类别 | orders.classification | 整批单一类别；混合分摊用order.update.classification.parts逐单复核，不冒充原子批量 |
| 表格上传／字段预览／重映射／入账 | files.stage → import.analyze / import.remap / import.preview → import.commit | 原件SHA、工作表/表头、字段列映射；异常／重复／冲突行不可偷偷覆盖 |
| 图片/PDF识别、粘贴文字 | files.stage → ocr.start / ocr.status / ocr.text → ocr.commit | 同一持久jobId；一个采购单多原件；多个不同订单号仍拒绝混为一单 |
| 全局取消识别 | ocr.cancel（新增）及可信任务signal | 合作取消PDF/Tesseract，1.5秒兜底终止真实fork；退出后才记cancelled；原件和jobId保留 |
| 丢失启动响应后取消 | 内部ocr.cancel.startRequestKey | owner＋原中央taskId限定；持久取消意图早于晚到的启动时不再fork；不盲目重启 |
| 月度任务卡、本人分派 | tasks | 对照历史staffId，不把全局模块权限当成历史归属 |
| 分派／开始／提交／验收／退回 | task.action | 支持主页真实assigneeActorId，经显式映射到历史staffId；员工不能代办 |
| 管理员核对任务 | task.mark | 经办人取可信登录绑定，拒绝指定其他经办人 |
| 主页人员与历史采购任务归属 | people.mapping / people.bind（新增） | 只绑定历史归属，不创建主页人员或更改权限；管理员中央复核精确ID，重名必须让用户选择；旧分派主键及审计不改写 |
| 平台月度确认／预览／历史 | months / month.confirm / month.cancel | 单平台新prepare；取消仅管理员；不开放密码给模型 |
| 批量月度确认／取消 | 按平台依次months→prepare→中央复核→commit | 每次写入后重新prepare，避免复用旧revision；不承诺跨平台原子提交 |
| 订单来源、原件 | sources / source.file | 真实文件摘要，主机download登记artifact |
| 订单历史、补充来源、审计列表 | audit | 保留原历史及补充来源 |
| 审计单条明细 | audit.detail（新增） | auditId不是orderId，直接复用auditLog.detail |
| 审计回滚预览／提交 | audit.rollback | 单条／批次范围、逐条版本、中央复核 |
| 供应商管理、档案、历史 | suppliers / supplier.save | 原供应商档案及版本，不合并同名商家 |
| 历史采购店铺支出汇总 /api/suppliers | suppliers.summary（新增） | 原supplierSummary，未建档店铺同样可见，不以档案列表替代 |
| 收货地址新增／修改／删除／搜索 | addresses / address.save / address.remove | 原地址版本和关联检查 |
| 来源图片索引、缓存 | image.prepare / image.cache | 原图片来源及受控下载器；保留来源绑定与人工核对标记 |
| 已缓存订单图片原件 | image.file（新增） | 校验assetId确属所选订单，再由主机登记真实artifact；不让模型输入URL或路径 |
| 附件上传、列表、下载、暂存删除 | files.stage / attachment.stage / attachments / attachment.file / attachment.remove | 订单正式关联仍经order.update/ocr.commit中央复核 |
| CSV订单／分类／年度月报／模板 | export.kind | 原报表生成器，真实artifact返回；不是仅返回模块URL |
| 历史导出采集批次核对、退款冲突选择 | transfers / transfer.verify / transfer.save | 保留账号、退款依据与字段keep/source |
| 采集批次正式导入／撤销 | transfer.commit / transfer.rollback | 原备份、版本、中央复核、逐单写后校验、未知回执回查 |
| 旧“待确认修改”列表与原差异 | edits（新增） | 读取integration_edit_drafts，不要求模型进入旧UI会话 |
| 旧待确认修改入账 | edit.commit（新增） | 原backup/propose/write/comparable核验；中央proof而非伪造UI session；回读已核验持久结果 |
| 新订单／修改订单／OCR待复核草稿更正 | order.create / order.update / ocr.commit.resultEditFields | 固定block.id＋rowKey=draftKey、字段白名单；只生成新用户要求并重新prepare，旧审批不能复用 |
| 主页人员主数据／权限、私网配置、公司AI | 主界面/host负责 | 采购不新增人员管理导航，不代填密钥 |
| 密码、备份恢复、迁移、服务启停、版本更新 | 主机受控操作／原本地入口 | 不对模型暴露密码或任意路径；非缺失采购业务能力 |
| 旧移动录入与识别页面 | 原mobile-access保留；同类业务由上述采购能力覆盖 | 不迁走旧移动会话与其安全策略；需包内/真实设备统一验收 |

## 导出台旧入口

| 原入口／行为 | Agent能力 | 证据／边界 |
|---|---|---|
| 平台／任务总览 | state / task | 真实导出台任务ID、日期范围、listOutcome与计划完整性 |
| 日期及按天／月计划采集 | start | 原collectors；等待登录、partial、超时均blocking |
| 暂停／继续／重试／结束 | pause / resume / retry / finish | 同原taskId查询，不将手动结束当完整采集 |
| 详情补全 | enrichDetails / orders / snapshot | 保留原分页、详情及完整性状态 |
| 登录／订单页面人工操作 | host-action | 登录、验证码、授权仍需人工；不返回假成功 |
| CSV／XLSX／附图片导出 | export / file | 真实文件元信息及download/registerArtifact；上限64MiB，超限按平台/日期分批或关闭图片 |
| 送采购核对 | transfer | 中央复核后调用原转采购链，采购再单独复核入账 |
| 采集缓存清理 | clear | 中央管理员审批、忙时拒绝，保留已导出文件 |
| 辅助代理启停、执行日志配置 | proxyStart / proxyStop / setLogging / setExecutionLogVisible | 原处理器＋中央审批；不是新增平台采集能力 |
| 平台页面收起、执行日志 | hidePage / logs | 日志分页；收起不代表采集完成 |
| 输出目录、打开系统文件夹、安装证书、系统代理、升级 | 原本地／host入口 | 不允许模型控制任意系统路径或绕开操作系统授权 |

导出download原固定512MiB请求被主机默认64MiB校验拒绝，即使小文件也失败。本轮统一64MiB，原件保留在领域输出目录；模型得到明确拆分说明，不扩大主机安全预算。metadata增加真实bytes。作业block/evidence/issue均保持module=exporter和同jobId。

## 总控集成与最终验收边界

1. 人员主目录有效性仍由host的people.assignable实时查询；绑定输入必须使用该目录真实ID及用户明确选择的历史staffId。采购模块不读取权限配置文件、不创建全局账号；实际使用时仍由host重新校验签名人员权限。主界面不增加采购人员管理导航。
2. OCR适配器在有运行时signal时登记取消监听，等待达到时限返回后仍可触发底层取消；取消请求使用新10秒signal，不能复用已aborted的signal。服务重启中断保持interrupted，绝不当done。运行时停止/关闭触发signal，但持久任务跨重启取消接线与前端最终展示仍待集成验收。
3. runtime需依同module＋jobId＋终态证据清理历史blocking；取消只表示停止，不代表原采购目标完成。
4. 结果更正协议由主UI/runtime处理：corrections:{resultId,resultVersion,edits:[{blockId,rowKey,field,before,after}]}。本组只输出草稿元数据；id/updatedAt、历史订单查询、统计及已入账表不标可改。商品数组等复杂结构继续补充目标重生成，而不开放任意JSON写账。
5. 新测试已保留但未执行：agent-ocr-cancel、agent-personnel-mapping、agent-legacy-edit、job-completion/schema及exporter workbench增量；真实OCR进程取消、中央审批、包内附件/产物打开、真实平台及公司AI均待统一验收。旧192/192等记录只适用于旧sourceCommit。
6. 本组不进行正式迁移、安装或发布。用户要求后续只打安装器，不生成便携版本。


### 最新决策覆盖以上角色措辞

本日用户取消人员角色/模块权限限制。以上“管理员”“仅本人”“可用模块”等授权措辞不再是新Agent行为：所有签名登录成员同等访问全部采购/导出数据和功能；分派归属只是业务记录，非操作权限。历史归属绑定及实际操作者审计仍保留，中央复核也保留。旧local无签名工作模式及独立手机443接入不作为新Agent权限策略。详见同日handoff最新访问增量。


### Beta手机入口（managed模式增量）

`LINGTU_AGENT_MANAGED=1`的mobile.app现复用真实共享网关签名会话，所有已登录人员同等访问。正式独立443配置与非Agent旧策略保留。主服务镜像`/api/mobile/*`白名单，手机页从共享工作台`/apps/purchase/mobile.html`进入；27380是验签后端而非裸公开入口。详见同日handoff的精确路径/会话/CSRF契约。源码已补、HTTP及真实设备用例未运行。
