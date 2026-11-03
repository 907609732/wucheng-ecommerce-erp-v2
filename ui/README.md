# 共享 UI 与期间选择器

恢复来源：归档分支 codex/business-runtime-slimming 的 f8aaae6，以及保存完整时间组件的 stash e0cc5e7。恢复范围与验证步骤见 [浏览器恢复计划](../docs/superpowers/plans/2026-11-03-restore-unified-ui.md)。不恢复 Electron 或导出器。

## 唯一维护入口

- tokens.css：品牌色、文字、背景、边框、尺寸、字体与密度。
- base.css、components.css：通用控件、弹层、表格、状态及期间选择器。
- chart-theme.mjs、icons.svg：图表颜色和图标。
- vendor/：现有第三方组件的样式覆盖，不引入新运行依赖。
- period-picker.mjs：年、月、日统计期间组件。

修改本目录后执行 `npm.cmd run sync:ui`。它同步到三个业务台的 public/ui/，并将 tokens.css 同步到浏览器入口 server/public/。`npm.cmd run check:ui` 检查副本漂移，CI 也执行此检查。不要手改分发副本。

页面按 tokens.css → base.css → components.css → 所用 vendor 覆盖 → 业务专用样式的顺序加载。加载画面仍由 shared/ui/ 维护，使用原 sync:loading 命令。

## 期间组件

```html
<div data-period-picker data-picker="example-month"
     data-grains="month,year" data-grain="month" data-period="2026-10"
     data-stepper="true" data-label="统计周期"></div>
```

```js
import {mountPeriodPickers,disposePeriodPickers} from './ui/period-picker.mjs';
const controller = mountPeriodPickers(root, {
  beforeChange: next => canLeaveCurrentDraft(next),
  onChange: ({grain, period}) => refreshBusinessView(grain, period),
}).get('example-month');
// 路由或服务端回填时不要再次派发选择事件。
controller.set({grain:'month',period:'2026-10'},{silent:true});
// 页面重绘、销毁前解除旧监听。
disposePeriodPickers(root);
```

`data-clearable="true"` 允许全部月份（period=null）；统计筛选不再使用快捷月份条；`data-store-key` 在本机记忆选择；`data-min` / `data-max` 限制范围。每个控件使用独立的 picker/store key。始终显示“日/月/年”，`data-grains`声明可用粒度，其余项禁用并通过title与aria-label解释。路由切换使用`controller.setGrains(['month'], {reason:'本页按月度账期处理'})`限制粒度，不派发选择事件；调用方同步返回的grain/period，业务请求仍遵守原接口粒度。

业务只接收 grain 与 ISO period：day=YYYY-MM-DD、month=YYYY-MM、year=YYYY。中文显示仅负责展示，不改变金额、业务日期、锁月或统计口径。发生日期表单保留日期语义，不把月份当作实际记账日期。

交互链为组件校验 → 可选 beforeChange 拦截 → 更新显示与记忆 → 一次 lt-period-change / onChange。未保存表单必须使用拦截钩子；路由回填使用 silent，避免重复请求。键盘支持方向键、翻页、Enter、Escape 与焦点恢复。

preview.html 是组件画廊。测试证据和截图存放在仓库外，不提交账本或浏览器登录资料。
