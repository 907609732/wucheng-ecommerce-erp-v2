# 真实查询图表与可修改草稿

`lib/agent-presentation.mjs` 是无数据库写入的展示装饰器。它接受已经运行真实领域查询/预演的结果，返回新对象；不修改领域结果、不重新计算财务合计、不创建新业务数据。接线由 Agent actions 与适配器负责。

## 接线接口

```js
import {
 decorateSalesQuery,
 decorateSalesPreparation,
 salesCapabilityPresentation,
 salesResultEditFields
} from './agent-presentation.mjs';

// 实际 domain 查询完成后；普通输出、原件字节等非目标查询原样返回。
const output = decorateSalesQuery(capabilityId, input, actualQueryResult);

// 实际领域预演完成后；commitData/changes 保持服务端原草稿内容。
const prepared = decorateSalesPreparation(capabilityId, input, actualPreparation);

// 合并到能力声明。只有明确支持编辑的 4 项返回 resultEditFields。
const capability = {...definition, ...salesCapabilityPresentation(definition.id)};
```

服务端 query envelope 必须保留模块返回的 `blocks/evidence/scope`，不能用通用 table 覆盖它们。`decorateSalesQuery` 同时保留根对象原有 `trend/operations/reconciliation/totals/by_shop/channels` 和已有 blocks，并追加只读明细表，避免加入图表后明细不可查看。

## 图表数据口径

| 查询 | 图表 | 真实取值 |
| --- | --- | --- |
| `sales.report` | 月度或日度 line | 原 `trend[].label/sales/refunds/ad_spend`；金额是领域已经生成的人民币参考折算整数分 |
| `sales.freight-report` | 月度或日度 line | 原 `trend[].label/total/shipping/extras/other`；整数分，保留负赔付 |
| `sales.freight-report` | 费用分类 bar | 原 `totals.shipping/packing/materials/storage/other`；不从图表倒推或合成费用 |

每个 chart 显式声明 `type/id/title/chartType/dimension/series/rows/sourceRefs/completeness/scope`。series 的金额 `unit:'分', currency:'CNY'`，行中没有取得的金额继续为 null，不除以 100，不补 0，不猜汇率，不把差额命名为利润。源查询确认的真实零仍是 0。

`sourceRefs` 逐项引用同一结果 `evidence[].id`。来源标记为 `kind:'query-result'`，ID 使用能力、查询 scope 和真实源数据 SHA 稳定产生；说明引用的是领域查询结果，不冒充某份未列出的官方原件。相同内容重复装饰不会重复增加 chart 或 evidence。

经营图只有原 `totals.complete`、每个趋势行 complete 以及全部图示金额都完整时才为 complete；其余为 partial 并解释缺失。运费图始终 partial，因为领域只证明“已登记费用”，不证明完整官方账单。原币经营、结算和收款明细仍保留原始币种及整数分值。

## 草稿编辑边界

仅 `ledger-create/ledger-update/freight-create/freight-update` 声明 `resultEditFields:string[]`。字符串是实际行字段名，不是 `input.` 路径。新增的可修改 table 具有：

```js
{
 type: 'table',
 id: 'sales.ledger-create.draft',
 rowKey: 'key',
 editableFields: ['shop_id', 'date', 'kind', 'amount', /* 已存在的允许字段 */],
 rows: [{key: 'ledger-create:<业务身份摘要>', amount: '12.55', /* 原输入 */}]
}
```

草稿行从原业务 input 取值，金额是元字符串，不从预演结果的整数分复制。稳定 key 绑定 operation、实体 ID（有则使用）、店铺/业务日期或月份和原业务编号，不使用隔离预演临时生成的随机 ID。`editableFields` 是该能力白名单与本次已存在 input 字段的交集。

记录 ID、version、附件数组、附件移除列表、审批、角色及内部 commitData 不作为单元格编辑字段。原领域预演表、历史查询和图表没有 editableFields，不能直接修改账本统计。修改草稿单元格后必须按新业务输入重新准备、重新运行 Schema/权限/领域规则，并重新取得中央人工审批；不得直接复用旧 changeDigest、草稿或审批证明。

## 测试状态

`test/agent-presentation.test.mjs` 已提供使用 `os.tmpdir()` 临时 SQLite 的实际领域数据用例：经营趋势与缺失月份、缺失真实汇率、负赔付运费、同结果 sourceRefs、原对象不变、只读统计、稳定草稿 key、输入元/领域分隔离及编辑白名单。

该文件在本子任务中 **未运行**，遵循主任务统一接线与验证的安排。它不证明 UI 已渲染或真实平台已验收；主任务还需运行测试并验证 query envelope 和中央结果编辑链路。
