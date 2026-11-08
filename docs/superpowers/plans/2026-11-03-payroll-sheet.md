# Payroll sheet implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** 将人力支出改成可编辑的应付工资在线表格。
**Architecture:** 复用 Tabulator、工资账单、付款与审计；独立批量接口以同一事务提交普通工资行。
**Tech Stack:** Node 24、SQLite、Express、原生JS、现有Tabulator。
**Spec:** ../specs/2026-11-03-payroll-sheet-design.md，用户已确认。

## Constraints / review focus

源码开发版、隔离数据，不打包、不准备版本目录、不切正式。付款绝不隐式生成；复杂工资单不被三列表格覆盖；多行保存全部成功或全部回滚；版本冲突和重复提交受保护；草稿在导航/刷新/关页时不丢失。

- [x] 1. tests + public/payroll-model.mjs：严格金额解析、行映射与普通工资识别，先失败后通过。
- [x] 2. lib/payroll-sheet.mjs + server.mjs + workbench-manifest.json：批量保存、请求回执、版本校验和事务回滚；测试重复提交、非法行、并发、付款隔离及复杂工资保护。
- [x] 3. public/payroll-sheet.js/css：表格编辑、粘贴、增行、草稿、合计、保存与导入导出/账单详情入口；接入app.js及business-surface.js。
- [x] 4. 运行相关测试与隔离浏览器验证；独立代码审查；打开源码开发版人力页供用户查看。

验收结果见 ../../payroll-sheet-acceptance-20261103.md。

## Decisions

- 日期使用原账单日期，账期使用页面所选月份；跨月日期不自动移动账期。
- 原有多人员/代扣/公司承担的复杂工资显示原明细、只读网格，通过现有更正入口维护。
- 草稿仅驻内存，不把工资草稿写入浏览器持久存储；保存失败/冲突保留草稿。
- 不触碰尚待确认范围的资金/运费锁定需求。
