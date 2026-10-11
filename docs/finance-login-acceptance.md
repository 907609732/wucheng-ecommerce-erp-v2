# 店铺销售额采集：登录优先流程验收记录

## 已实现的流程

点击「添加店铺」直接打开独立千牛登录窗口；本人登录后只读识别账号及可靠的当前店铺字段，简短确认后保存。确认前不创建占位店铺或取账任务，不采集账单金额。未读取到店名时只补充店名；主体、税号等保持未知，后续可在店铺设置补充。新店取账计划默认关闭。

不同店铺采用独立登录分区。成功保存沿用原登录分区，不复制用户其他浏览器或原生千牛的凭据。重复添加不覆盖已有设置和账单。保存过程中导航、账号或登录窗口变化会阻止错误绑定。

## 第二轮风险修复

1. 普通关闭可能被网页否决，管理器保留活窗口引用。取消仅针对显式标记的临时窗口，确认已销毁后再清理分区；销毁或清理失败不报告完成，保留可重试状态，拒绝清理普通或已绑定店铺。
2. 不再把整个页头视为身份来源。仅接受具名当前店铺 section 内直接、明确、无聚合内容的字段；兄弟订单卡片、嵌套区域、其他 aria 区域的主体和税号不回填。

## 父代理实际复跑结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:finance` | 123/123，退出码 0 |
| `npm run test:finance-safety` | 22/22，退出码 0；真实 Electron 关窗否决、真实 Chromium 八种布局并读回临时账本 |
| `npm run test:finance-login` | 退出码 0；添加入口、确认前不建店、取消、重复、账号变化、分区隔离、受保护页面认证复用及重启 |
| `npm run test:finance-rpa` | 最新前台完整运行退出码 0；仅本地合成页面，不代表真实平台下载验收 |
| `npm run docs:features` | 退出码 0，说明书同步导出 |
| `npm run test:feature-help` | 内容测试 4/4，界面测试通过 |
| `npm run test:finance-ui` | 并行验证时一次窗口意外关闭；随后独立重跑通过，原因尚未确认 |
| `npm run test:desktop` | 35/35，退出码 0 |
| 相关源码 `node --check` | 退出码 0 |
| `git diff --check` | 清除文件末尾多余空行后退出码 0 |

专项安全与财务测试部分重叠，测试数量不相加。测试数据全为合成数据，未操作用户真实账本、未进行真实平台登录。

## 独立复审

第二轮最终独立复审不通过（报告：`dist/finance-login-verification/second-cycle-review-verdict.json`）。原先普通关窗否决及同页头兄弟 div 用例已修复，但新增真实 Chromium 复现：订单 div 内的嵌套 header 或 banner 仍可取得身份来源，与当前账号/相同店名拼接后把交易对方主体和税号写入临时账本。文档级身份区域还需排除嵌套页头和其他具名 aria 区域。

父代理与独立复审还分别复现保存收尾的阻断：`attachShop` 已将 `context.draft` 设为 false，后续确认校验遇到登录状态变化会回滚新建店铺；但 `discardDraft` 拒绝清理该分区，再次取消同样被拒绝。实跑退出码 1，店铺记录为 0、pending 仍保留、原生窗口仍存活、storage 未清理。必须保持暂存资格直到最终成功，或为本次私有创建提供可验证的失败清理路径；不可放宽既存店铺保护。

证据：`dist/finance-login-verification/parent-post-attach-repro.mjs`、`parent-post-attach-evidence.json`。本地边界替身与真实浏览器管理器/状态机/账本代码，全部为合成数据。当前总体验收不通过。用户已明确授权额外一轮限定修复，范围仅上述嵌套页头归属和最终提交/失败清理两项；修复正在独立上下文中执行，未打包或发布，完成后须重新验收。

## 证据路径

仓库下 `dist/finance-login-verification/`：
- `second-fix-report.json` 及其引用的 RED/GREEN 原始日志和生产 diff。
- `parent-second-test-results.json`：父代理实际复跑命令、退出码与测试数。
- `parent-second-finance.txt`、`parent-second-finance-safety.txt`、`parent-second-finance-login.txt`。
- `second-cycle-static-scan.json`、`second-cycle-independent-review.md`。

## 未验收边界

- 真实千牛 DOM、实际可读的店铺资料、登录有效期及真实平台下载尚未验收。保守语义来源可能无法识别所有信息，不可承诺全部资料自动读取。
- 未提供真实淘宝月汇总 Excel，实际工作表、列名、账期和金额字段仍需原表核对。
- 未 commit、未打包或发布，不能把当前源码测试当作用户已安装版本生效。
