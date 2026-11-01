# 采购台 UI 设计工具调研

本次只读研究了以下 5 个开源项目的上游 README、Skill 或官方文档，未安装或执行新工具。当前目标是采购台现有原生 JavaScript、CSS、Express 与 Tabulator 界面的统一改版，不迁移前端框架。

用户选择的方向：冷灰、白、蓝的现代工作台，参考飞书、Linear 的克制层级与操作组织。设计依据仍是采购数据处理、兼职逐项执行和日常核对，不直接套用网站营销模板。

## 对比

| 项目 | 能力与适用性 | 账号 / API Key 范围 | 许可证与状态 |
| --- | --- | --- | --- |
| Anthropic `frontend-design` | 以行业和真实内容确立视觉语言，指导字级、布局、色彩、文案和设计自审。可用于现有原生 JS/CSS，作为本次主要视觉指导。 | 阅读文本 Skill 不需要外部账号或 API Key。 | 已读取同目录 `LICENSE.txt`，为 Apache-2.0；本次未安装。 |
| ibelick `ui-skills` | Skill 集合，也有检索 Skill 的 MCP。采用 `fixing-accessibility` 审查控件命名、键盘、焦点、表单和状态。`baseline-ui` 的间距与层级规则仅作通用参考，其 React/Tailwind 约束不用于本项目。 | README 提供公开 MCP 地址及 `list_skills`、`get_skill`，未列出 API Key 前提；本次未连接验证认证行为。读取公开 Skill 不需要账号。 | GitHub 与 README 声明 MIT；本次未安装或连接新 MCP。 |
| NextLevelBuilder `ui-ux-pro-max-skill` | 本地设计规则检索，覆盖产品、样式、配色、交互和图表。可作为规范资料；当前明确列出的技术栈没有纯 CSS，不强套 React/Tailwind 模板。 | README/Skill 描述的本地 Python 检索不依赖外部 API Key；要求 Python 3，声明无第三方 Python 依赖。本次未执行检索脚本。 | GitHub 与 `skill.json` 声明 MIT；本次未安装。 |
| shadcn 官方 MCP | 浏览、查找、安装组件注册表。可参考组件层级与状态设计；其 React/Tailwind 组件不直接引入原生 JS＋Tabulator 采购台。 | 官方文档的默认公开注册表配置未要求 API Key；私有或第三方注册表可有各自认证。本次未连接或安装组件。 | 仓库声明 MIT；不据此推定所有第三方注册表组件也采用同一许可证。本次未安装。 |
| Framelink Figma MCP | 将已有 Figma 文件的布局与样式信息提供给编码代理，适合有设计稿后的实现校对，并非独立的 UI 设计生成器。 | README 明确要求 Figma Access Token 和可访问的设计文件。 | GitHub 与 `package.json` 声明 MIT；本次未安装。已有 Figma 插件已通过插件清单确认安装，不重复引入该 MCP。 |

## 上游链接

### Anthropic frontend-design

- [GitHub Skill 目录](https://github.com/anthropics/skills/tree/main/skills/frontend-design)
- [SKILL.md 原文](https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md)
- [LICENSE.txt](https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/LICENSE.txt)

### ibelick UI Skills

- [GitHub 仓库](https://github.com/ibelick/ui-skills)
- [README](https://raw.githubusercontent.com/ibelick/ui-skills/main/README.md)
- [baseline-ui SKILL.md](https://raw.githubusercontent.com/ibelick/ui-skills/main/skills/baseline-ui/SKILL.md)
- [fixing-accessibility SKILL.md](https://raw.githubusercontent.com/ibelick/ui-skills/main/skills/fixing-accessibility/SKILL.md)
- [许可证](https://github.com/ibelick/ui-skills/blob/main/LICENSE)
- MCP 地址：`https://www.ui-skills.com/mcp`

### UI UX Pro Max

- [GitHub 仓库](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
- [SKILL.md 原文](https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/.claude/skills/ui-ux-pro-max/SKILL.md)
- [skill.json](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/skill.json)
- [许可证](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/LICENSE)

### shadcn MCP

- [官方 MCP 文档](https://ui.shadcn.com/docs/mcp)
- [GitHub 仓库](https://github.com/shadcn-ui/ui)
- [许可证](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)

### Framelink Figma MCP

- [GitHub 仓库](https://github.com/GLips/Figma-Context-MCP)
- [README](https://raw.githubusercontent.com/GLips/Figma-Context-MCP/main/README.md)
- [package.json](https://raw.githubusercontent.com/GLips/Figma-Context-MCP/main/package.json)
- [许可证](https://github.com/GLips/Figma-Context-MCP/blob/main/LICENSE)

## 本次采用方式

1. 用 `frontend-design` 校准业务语境、视觉层级和真实文案，减少无意义的装饰标签、重复卡片、大型进度宣传区和自动入场动效。
2. 用 `fixing-accessibility` 审查交互；保留现有采购流程、月份筛选、核对与月锁规则。
3. 从 `baseline-ui` 参考数据等宽数字、清楚的空态和单一主操作等通用原则，不按其栈要求改造项目。
4. 继续使用现有浏览器验收实际界面；没有 Figma 设计稿时，不为改版额外要求 Figma Token。

## 核验边界

公开仓库和上述原文可访问。查询精确维护时间时，GitHub API 返回匿名限流 403，未核实最后推送日期；不以星标数代替维护和质量判断。许可证说明以已读取的上游声明为限，不代表对所有依赖或第三方组件完成许可证审计。
