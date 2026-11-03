# Unified workspace implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task.

**Goal:** 三个业务台的展示边界、页面层级与时间交互一致。
**Architecture:** 原生 HTML/CSS/JS，复用 ui/period-picker.mjs 与共享 tokens，无新增运行依赖。
**Spec:** ../specs/2026-11-03-unified-workspace-design.md（用户已确认，月度业务显示禁用日/年）

## Constraints and review focus

- 不改正式账本、不改变统计含义；发生日期字段保持原语义。
- 不支持粒度始终禁用，切换路由后不可残留非法粒度。
- 布局在桌面和375px不横向溢出；表格内部滚动。
- 单次选择只刷新一次，未保存草稿拦截与键盘焦点不退化。
- 连续切换检查独立记录，不把未复现的卡顿宣称修好。

## Tasks

- [ ] 1. 浏览器记录旧版期间控件和页面几何，验证旧版未满足新契约。
- [ ] 2. 修改 ui/period-picker.mjs：三个粒度始终显示、限制集合动态更新、禁用说明、统一步进，去除快捷条使用；补期间限制测试。
- [ ] 3. 三台 HTML/JS 使用统一页头面包屑、正文标题与筛选行；仅支持月页面绑定月粒度，消除重复时间筛选和额外确认。
- [ ] 4. 清理 ui/components.css 重复骨架及模块宽度覆盖，统一响应式边界；同步 ui 资产。
- [ ] 5. 在工作区外复制源码复用外部依赖，运行相关单元回归与浏览器尺寸/交互验收；独立审查差异。
- [ ] 6. 准备独立正式候选版本，使用现有备份、更新和回退流程，核对 HTTPS 正式页面；记录未完成项。

## Execution notes

- 用户确认时间限制方式，按建议布局继续实施。已有源码只有本轮设计文档未提交。
- UI设计代理已完成只读审查；后续实现调用因容量失败，改为主代理执行同一审查建议。
