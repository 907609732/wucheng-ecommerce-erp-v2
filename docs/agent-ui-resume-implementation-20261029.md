# 结果工作面续接实现

基于策划、UX 的 2026-10-29 交接，完成共享 UI 源码接线。按照用户要求，本轮没有运行中间测试、浏览器探针或包体测试；以下是实现清单，不是验收结果。

- 文件预览与下载拆分。`artifacts.preview` 只接收中央 artifact，前端再次核对 MIME 白名单、12 MiB 上限、字节数和 SHA-256；使用临时 Blob URL，在关闭、切任务/版本/页面时释放。PNG/JPEG/WebP 有适应窗口与缩放，PDF 使用受限 iframe 中的内置查看器和其页码/缩放工具。格式/权限/摘要/读取失败显示明确说明，保留重新鉴权下载。
- 原件查看层为原生 dialog，支持 Esc、焦点恢复和可见关闭按钮。CSP 仅新增图片 `blob:` 与 `frame-src blob:`；未开放远程脚本、任意 iframe URL、HTML/SVG 内嵌或 inline 脚本。
- 草稿更正须同时满足当前结果/状态/人员、能力 `resultEditFields`、块 `editableFields/id/rowKey/sourceModule/sourceCapabilityId`。只编辑简单值，保留原值与逐项差异，提交 `tasks.input` 的版本绑定 corrections。请求接收后显示重新生成而非已入账；已有草稿更正会禁用原审批提交。取消、离开提醒、陈旧版本提示与历史只读已接线。
- 声明式图表只接受 `line/bar + dimension/series/rows/sourceRefs/completeness`。来源引用必须在当前 evidence 中存在；按单位和币种分别画图，不自动聚合重复维度，不把缺失值当零，折线不连接缺口。明细表始终可查看。不支持或数据有问题时显示原因与明细。
- 图表复用已安装的 `echarts/dist/echarts.esm.min.js`，通过受控选项构建 SVG 图形，tooltip 使用 richText 避免数据作为 HTML。未接受模型 option、函数、HTML 或下载链接。完整程序包需保留 ECharts 生产依赖。
- 历史异步问题带 `resolved:true` 时显示“已解决”，历史内容仍保留。

集中验收仍需确认：实际 Electron 的 Blob PDF 查看器与 CSP、390px/键盘/焦点，取消预览与切任务的异步交错；业务适配器是否实际声明编辑元数据；服务端旧值/版本/权限校验与新 prepare 链；ECharts 生产依赖在完整包内的资源路径、图表缺数/多币种/可访问明细。尚未提供这些验收证据。

集中验收脚本已补充为 `tests/agent-result-tools-ui.mjs`，复用既有测试的本地静态服务和合成 authenticated launcher，操作生产工作面的真实 DOM 和实际 ECharts。覆盖草稿只读/陈旧/取消/版本绑定、更正提交后执行状态、图片预览的 SHA/类型拒绝/关闭释放/迟到结果、缺数与真实零、来源引用、多币种分图、resolved 历史及 390px。脚本只写入，未执行。它不验证真实主机授权、公司 API、业务入账或正式平台。

源码审读同时发现并修复了结果缓存只看 result JSON 导致任务状态变化后旧编辑入口残留的问题：缓存现纳入任务状态、历史选择和当前写权限/能力；进入编辑和提交更正均重新校验当前资格与版本。
