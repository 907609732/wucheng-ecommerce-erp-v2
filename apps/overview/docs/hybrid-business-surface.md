# 经营工作面混合恢复

本轮只修改经营总览静态页面及包内资源，未修改后端领域、鉴权、权限管理、主机或销售模块。按本轮要求未运行测试、浏览器、打包、安装或正式数据操作；下面是实现契约与待验收边界，不是运行通过证明。

## 固定主机接口

`window.wuchengBusinessSurface` 暴露：

- `protocolVersion:1,module:'overview'`。
- `getContext()`：只读状态快照，包含 route、期间、日期口径、filters、selectedIds、selectionMode、recordCount、sourceLocator、confirmed。初始加载/失败 confirmed:false；成功渲染后才 confirmed:true。未选记录使用 current-filter；计数不可知时 null，不冒充全账本范围。不包含 token、原始表单、附件内容。
- `getDraftState()`：dirty、busy、canSave:false、persistence:'memory-only'、openForms。工资、其他费用、付款、分类、覆盖、上传/恢复表单仍由原表单实际提交。没有保存本地持久草稿 API，不能宣称退出/崩溃后恢复。
- `navigate(target,{discardDraft:false})`：只接受受控 module、view、recordId/sourceId/batchId、period、basis。未保存时返回 blocked/unsaved-draft；实际保存进行中返回 blocked/save-in-progress。只有明确 discardDraft:true 才移除本地未保存表单，不发正式业务写入。未知记录返回 not-found，不猜替代记录。

同台导航只改变当前页面/记录，跨台导航发 `wucheng-business-navigate` DOM 事件，detail 为受控来源结构；不会 window.open 或拼接裸端口 URL。原生固定 preload 负责接收事件并在同壳定位实际工作面。状态变化发 `wucheng-business-state`，detail 为 `{protocolVersion,module,context,draft}`。主机普通切台应仅隐藏复用既有视图，不调用 reload/loadURL 或销毁页面，因此筛选、滚动和表单仍在。

主机端 WebContentsView 的真实签名 UI、边界布局、事件转发、返回 AI 结果及测试账本标识仍由主集成负责。这里不把裸端口能打开当作完成。

## 运费收敛

运费页面保留月份、店铺筛选、金额、待付、原件、已登记账单详情、付款/退款、云仓下载记录与导出。移除“填写”“再添加一张”、空白维护表和手工 Excel 维护入口；旧 quickFreight、importDialog('freight')、新增/更正运费按钮均转向单一“导入运费”。手工 bill-form 也拒绝 freight，后端原有领域保存保留供 AI 正式提交。

导入入口展示平台选择、既有内置 Skill 全文和提示词，菜鸟可用，商家寄件及顺丰待开通。原文从销售台已有静态资源复制为经营包内独立 vendor 副本，补充当前账本与旧 API 兼容边界；没有跨已安装模块相对 import。提示词与副本均明确 Beta/测试只用隔离账本，不能按默认正式注册表自动转入正式环境；目标不明只整理原件与预览；受管理台只能使用真实身份及既有 AI 结果人审，不能模拟角色会话或绕过签名。副本不是另一套执行器，也不表示实际采集已完成。

## 保留的人工能力

经营图表、来源详情、分类/退款日期、覆盖确认、费用/人力人工新增/更正、工资多人员明细与恒等式、付款/退款/撤销、历史和快照继续使用原页面与领域接口。来源按钮改成“在采购/销售中查看”的受控定位事件；原件下载继续使用真实原件接口。

未保存输入会阻止同台刷新/来源跳转和替换表单；明确关闭/取消时可继续填写或确认放弃，没有假“保存本地草稿”。成功领域保存后才清理该表单 dirty 状态。外部来源变化不覆盖未保存表单。

## 待集中验收

待运行新增隔离 UI 契约测试与现有领域回归；待主机同壳签名入口联调。重点包括：人工工资/其他费用/付款真实保存、失败保留输入、切台隐藏复用、来源 recordId/sourceId/batchId 定位与返回、当前筛选上下文、运费只导入、平台原文资源读取及剪贴板失败提示。此阶段未验证真实平台下载或正式数据写入。
