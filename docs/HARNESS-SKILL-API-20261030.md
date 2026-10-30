# Harness 与技能页最小接口契约

状态：2026-10-30 产品/API 提案，供 UI 与 runtime 同批实施；未修改生产源、未执行模型或测试。字段以下列约定为准，避免前端仅保存内存表单。

## 复用现有 Harness

复用公司任务中心、Codex App Server、已安装 Hermes 0.21.0 ACP 及 `AIAgent`。Hermes 官方提供 ACP 会话、流事件和取消；custom provider 承接 OpenAI 兼容服务，非兼容协议需要其对应适配。本轮维持现有 Hermes `provider=custom`，不新增代理服务、SDK 框架或供应商后台。[官方程序接入](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)、[官方供应商扩展](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-providers)、[官方 GitHub](https://github.com/NousResearch/hermes-agent)

本机 ERP 的 `hermes-engine.mjs` / `hermes-bootstrap.py` 已显式注入公司模型、接口和密钥，并把工具限制在五个 ERP MCP 工具。继续使用现有 `settings.get/save` 和本机安全凭据存储；用户保存的 DeepSeek 密钥保持原处，不复制个人配置。UI 分开显示“已配置”“引擎可用”“实际任务结果”，不把地址保存成功称为任意 API 已兼容。当前 DeepSeek/Hermes 实跑证据由总控记录，不能转标所有供应商或 Codex 已通过。

## 共同数据结构

同一个技能页管理 `kind: "skill" | "prompt"`，均使用 `skills.*`，不另造提示词存储。

```json
{
  "skill": {
    "id": "server-generated-uuid", "kind": "skill", "name": "检查定时任务",
    "version": 3, "latestRevision": 2, "activeRevision": 1, "enabled": true,
    "origin": "custom", "updatedAt": 1793334000000, "updatedBy": "real-actor-id"
  },
  "revision": {
    "number": 2, "sha256": "server-computed-content-hash", "changeNote": "补充结果要求",
    "createdAt": 1793334000000, "createdBy": "real-actor-id",
    "definition": {
      "schemaVersion": 1, "kind": "skill", "name": "检查定时任务", "description": "只读检查",
      "modules": ["system"], "platforms": [],
      "instructions": "读取能力约定后，查询定时任务并展示真实数量。",
      "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
      "toolBindings": [{"module": "system", "capabilityId": "schedules.list"}],
      "outputRequirements": "保留结果和来源；没有记录时明确返回零条。"
    }
  }
}
```

`version` 是技能实体的并发修改号；`revision.number` 是不可变内容版本。`save` 总是新增内容版本；已有启用版本保持原值，用户显式启用新版本后只影响新任务。新建/导入默认停用。内置定义只读，可复制为自定义；本轮无需删除 API，停用保留历史。复用现有 entities：`skill` 与 `skill_revision`，通过现有事务写入实体、版本和审计，不增独立数据库。

字段限制：名称 1–100 字、说明最多 1000 字、instructions 1–20000 字、outputRequirements 最多 4000 字、toolBindings 最多 100 项、完整定义最多 128 KiB。模块仅六个现有模块；绑定必须真实存在并按 module+capabilityId 去重。`skill` 至少绑定一项能力；`prompt` 可不绑定。inputSchema 采用现有 JSON Schema 验证组件支持的对象子集，本轮不解析远程 `$ref`。服务端生成作者、时间、ID、哈希；客户端不能声明验证成功。

## IPC / HTTP 完整往返

统一使用 `launcher.agentRequest({operation,payload})` 和现有 `/api/workbench/v1/agent/request`；成功直接返回下表对象，失败沿用现有 code/message。`agent-api.mjs` 必须同步加入六个操作。所有真实已登录员工可查看使用；save、setEnabled、import 的实际写入要求 trusted UI，不重建角色权限，也不向五个模型 MCP 工具暴露配置修改。

| operation | payload | response |
| --- | --- | --- |
| `skills.list` | `{kind?, query?, includeDisabled?:true}` | `{skills:[技能实体摘要]}`；空为 `[]`，不放伪造默认项 |
| `skills.get` | `{id, revision?}` | `{skill, revision, revisions:[{number,sha256,changeNote,createdAt,createdBy}]}`；不传 revision 读 latestRevision |
| `skills.save` | 新建 `{definition,changeNote?}`；修改 `{id,version,definition,changeNote?}` | `{skill,revision}`；更新 CAS，新增 revision；不自动启用新内容 |
| `skills.setEnabled` | `{id,version,enabled,revision?}`；启用必传 revision | `{skill}`；启用前重新核对该版本与工具绑定；停用只阻止新任务 |
| `skills.export` | `{id,revision?}` | `{fileName,mimeType:"application/json",document,sha256}`；document 是下述便携对象，UI 可下载 |
| `skills.import` | `{document,dryRun:true}` 预览；确认 `{document,dryRun:false,expectedSha256,targetId?,version?}` | 预览 `{import:{definition,sha256,warnings:[],canImport:true}}`；确认 `{skill,revision}`，默认新 ID；指定 targetId 才更新并要求 version |

便携对象固定为 `{format:"wucheng.erp.skill",formatVersion:1,definition,changeNote?}`，最多 256 KiB。导出只含定义，不含公司配置、密钥、账务、登录态或实跑结论。导入服务端重算规范内容摘要，确认时必须等于 expectedSha256；不信任导入的 ID、作者、启用状态、验证标签。未知字段或不支持格式明确报错，不静默装成可运行技能。

## 运行时冻结与业务强制边界

创建任务保持现有参数，新增选择引用及参数：

```json
{"goal":"检查当前定时任务","engine":"hermes","scope":{"modules":["system"]},"skill":{"id":"uuid","revision":2},"skillInputs":{}}
```

服务端必须核对 skill 已启用、请求 revision 等于 activeRevision、输入符合该版本 inputSchema、绑定均存在且属于本次 scope。然后在任务创建同一事务保存 `skillSnapshot:{id,revision,sha256,definition,toolBindings:[{module,capabilityId,kind,inputSchemaSha256}]}` 和已校验 `skillInputs`。客户端不能传 snapshot 替代校验。`tasks.get` 的 task 返回 `{skill:{id,name,revision,sha256},skillInputs}`，便于 UI 展示实际执行版本；冻结全文保存在私有任务记录，不逐次混入列表。

两个引擎的 taskPrompt 均接收同一冻结说明和 JSON 参数，作为任务级流程指导；ERP 固定的身份、来源、金额、去重、锁月、正式提交复核与回执规则始终由运行时/业务服务执行。toolBindings 是已登记业务能力的依赖清单，不是任意命令、脚本或 MCP 地址；提示词步骤是指导，不等于后端已强制执行该步骤顺序。实际调用仍逐次经过现有 scope、schema、query/prepare/commit 规则。

暂停恢复继续使用原快照，不读取新编辑内容。技能停用影响未来新任务，已创建任务保留版本与历史；内容或绑定 schema 无法恢复时暂停并报具体原因。普通自由目标任务不强制选 Skill。定时任务若采用 Skill，保存 id+revision，触发新任务前重新核对启用状态，不悄悄升级版本。

实跑记录从实际 task/result/receipt 产生，只显示“未运行 / 实际任务待复核 / 实际任务完成 / 上次未完成”和对应 taskId、引擎、模型、时间；save、import、结构校验均不产生 verified 标记。失败与部分结果不包装为成功。

## UI 必须处理的状态

- 空态：解释可新建 Skill、提示词或导入 JSON；不要伪称已有通用技能。
- 编辑：显示 `version` 用于 CAS、当前内容 revision 与 activeRevision；“保存”后新版本待启用，“启用此版本”才切换；未保存内容先提示保存再运行。
- 运行：默认启用版本，展示实际版本；按钮调用真实 `tasks.create` 并进入该 taskId，不仅把文字填入输入框。
- 导入：先真实 dryRun 预览，再确认摘要提交；同名不隐式覆盖。导出使用服务端返回的便携内容。
- 错误：`SKILL_NOT_FOUND` / `SKILL_REVISION_NOT_FOUND` / `AGENT_REVISION_CHANGED` / `SKILL_DISABLED` / `SKILL_REVISION_CHANGED` / `SKILL_DEFINITION_INVALID` / `SKILL_BINDING_UNAVAILABLE` / `SKILL_INPUT_INVALID` / `SKILL_IMPORT_CHANGED`；保留编辑内容，提示重新加载或修正对应字段，不自建内存“成功”兜底。

实施顺序：runtime 持久化/API + 前端白名单 → UI 技能页完整 CRUD 往返 → tasks.create 冻结与双引擎同提示 → 定时引用与实际记录。先完成实现，再做本范围集中验收；不触碰已存 DeepSeek 密钥，不新装环境。
