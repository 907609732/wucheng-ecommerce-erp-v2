# Codex ERP 工具隔离：官方协议与本机验证

验证日期：2026-10-28。验证对象：Windows 上的 `codex-cli 0.150.1`，官方标签 `rust-v0.150.1`，源码提交 `90854393966b21e9ebfd21b122334eb09a20c93d`。

## 结论

仅关闭 shell、browser、computer、apps 等 feature，不能让 Codex 只保留 ERP MCP 工具。MCP 的 `enabled_tools` 也只约束对应 MCP 服务，不约束原生工具。

这个版本有可验证的原生收口方法：在 ERP 专属 `model_catalog_json` 中将选定模型的 `apply_patch_tool_type` 设为 `null`，配合禁用 shell 等 feature，Codex 不会注册补丁执行器。假 API 强行返回 `apply_patch` 时，本机返回 `unsupported custom tool call: apply_patch`，没有创建合成测试文件。此方法必须与受控模型代理的精确工具白名单、ERP 任务权限和正式提交复核同时使用。

仍会注册三个 MCP 资源工具。因此，原生配置本身不是“仅五个工具”的完整白名单；模型代理还要过滤并拒绝它们，业务 MCP 服务也不应提供任意文件资源接口。

## 官方依据与版本边界

1. [0.150.1 工具注册源码](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/tools/spec_plan.rs#L970)中，shell 注册受环境、feature 与模型 `shell_type` 共同控制；[补丁注册](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/tools/spec_plan.rs#L1099)明确要求 `apply_patch_tool_type.is_some()`。同文件第 1013 行在存在 MCP 服务时注册三个资源工具，第 1027 行由 `update_plan_enabled` 控制计划工具。
2. [0.150.1 配置 Schema](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/config.schema.json)中，`tools` 支持 `update_plan`、`experimental_request_user_input`、`web_search`；没有全局原生工具白名单。`features.tool_registry` 只配置名称冲突和工具元数据，不是访问控制。
3. [官方模型目录规范](https://learn.chatgpt.com/docs/model-catalogs)要求使用客户端对应版本的目录结构，并在改变工具元数据后实测。`model_catalog_json` 是启动时配置，在线程 `config` 中覆盖不会重新应用目录。目录应采用完整 `ModelsResponse` 包装及完整模型条目，不能只提供下文几个字段。
4. [工具分发源码](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/tools/registry.rs#L518)会拒绝未注册工具。[响应处理源码](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/stream_events_utils.rs#L289)在 `output_item.done` 时就准备执行工具，不能等 `response.completed` 后才校验前面已转发的内容。
5. 本机通过 `app-server generate-json-schema --experimental` 验证了 `thread/start` 和 `turn/start` 的实验字段 `permissions`；它与旧 `sandbox` / `sandboxPolicy` 互斥。命名权限 profile 属于补充措施，不替代工具白名单。[App Server](https://learn.chatgpt.com/docs/app-server)、[权限配置](https://learn.chatgpt.com/docs/permissions)。
6. 最新 [Windows 沙箱文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)的 MXC 兼容性探针要求 CLI 0.162.0 或以上，不能直接视为本机 0.150.1 的能力。[安全配置手册](https://learn.chatgpt.com/docs/enterprise/security-cookbook)同时提醒，Windows 文件隔离还需核对操作系统身份与 ACL；普通只读模式不能作为不同员工账本之间的读取边界。

升级 Codex、模型目录、工具命名模式或模型代理后，必须重新跑正向业务调用与负向原生工具测试，不能仅依据版本握手通过就继续运行。

## ERP 专属启动配置

下面是经本机验证的关键配置片段，不是个人 Codex 配置。路径、模型名称及端口由公司主机生成；真实公司 API 密钥留在受控代理，Codex 子进程只获得短期 loopback 凭据。

```toml
model = "<已登记的公司模型>"
model_provider = "erp_company"
model_catalog_json = "<ERP 任务专属目录>/models.json"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
project_doc_max_bytes = 0

[model_providers.erp_company]
name = "ERP controlled model proxy"
base_url = "http://127.0.0.1:<受控端口>/v1"
env_key = "ERP_MODEL_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = false

[tools.update_plan]
enabled = false
[tools.experimental_request_user_input]
enabled = false

[features]
shell_tool = false
unified_exec = false
shell_snapshot = false
apps = false
plugins = false
remote_plugin = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
computer_use = false
view_image = false
image_generation = false
code_mode = false
code_mode_host = false
multi_agent = false
multi_agent_v2 = false
memories = false
hooks = false
skill_search = false
skill_mcp_dependency_install = false
in_app_browser = false
in_app_local_automation = false
workspace_dependencies = false
tool_suggest = false
enable_request_compression = false
goals = false
request_permissions_tool = false
current_time_reminder = false
token_budget = false
deferred_executor = false

[mcp_servers.wucheng_erp]
command = "<公司主机固定的 Node 可执行文件>"
args = ["<固定的 ERP MCP 入口>"]
required = true
enabled_tools = ["erp_capabilities", "erp_query", "erp_prepare", "erp_task_result", "erp_ask"]
omit_tools_from = ["deferred"]

[mcp_servers.wucheng_erp.tools.erp_capabilities]
approval_mode = "approve"
[mcp_servers.wucheng_erp.tools.erp_query]
approval_mode = "approve"
[mcp_servers.wucheng_erp.tools.erp_prepare]
approval_mode = "approve"
[mcp_servers.wucheng_erp.tools.erp_task_result]
approval_mode = "approve"
[mcp_servers.wucheng_erp.tools.erp_ask]
approval_mode = "approve"
```

模型目录在该版本完整模型条目上覆写以下字段，保留实际模型的上下文与推理能力等其余字段：

```json
{
  "slug": "<与请求完全一致的已登记模型名称>",
  "apply_patch_tool_type": null,
  "shell_type": "disabled",
  "experimental_supported_tools": [],
  "use_responses_lite": false,
  "prefer_websockets": false
}
```

`use_responses_lite: false` 是本次 Responses JSON/SSE 探针的取值；它不意味着可以在没有回归测试的情况下修改其他模型的协议。目录读取失败、选定模型缺失、版本不匹配应关闭任务执行，不得回退到另一份未受控模型目录。

逐工具 `approval_mode = "approve"` 只授权上述查询、采集、准备、结果读取与补充问题能力。它不授权正式入账、发送或支付；ERP MCP 没有正式提交或审批工具，正式变更仍由真实人员在结果页确认。[0.150.1 MCP 审批实现](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/mcp_tool_call.rs#L2222)。不应通过把所有工具都标成只读来消除提示。

## 实机正负向测试记录

测试完全使用临时任务目录、独立 `CODEX_HOME`、独立用户目录环境变量、loopback 假 API 和合成业务结果。没有公司 API 请求，没有正式账本访问，也没有修改个人 Codex 配置。此实验特意绕过模型代理，以证明原生注册层确实生效。

| 检查项 | 观测结果 |
| --- | --- |
| 本机二进制 | `codex-cli 0.150.1`；App Server 初始化及任务完成正常 |
| 发往假 API 的原生工具 | 仅 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` |
| 发往假 API 的业务工具 | `mcp__wucheng_erp` namespace 下五个固定 ERP 工具 |
| 假 API 强行返回 `custom_tool_call`，名称 `apply_patch` | 工具输出 `unsupported custom tool call: apply_patch` |
| 补丁试图创建 `rejected-canary.txt` | 任务目录内文件不存在 |
| 随后返回 `function_call`，namespace `mcp__wucheng_erp`，名称 `erp_capabilities` | 实际 MCP 子进程通过任务桥执行，调用记录为 `erp_capabilities` |
| MCP 返回的合成业务数据 | 能力 `synthetic.read`，领域 `sales`，类型 `query` |
| 完成状态 | 三次假 API 请求后任务 `completed` |

第一次未配置逐工具 approval mode 的探针中，ERP 调用被拒绝，原因是 `MCP tool call requires approval, but approval policy is never`。补充上述五项明确配置后正向调用通过；此前失败不是 namespace 不匹配。

本机研究副本位于 `%TEMP%/erp-codex-official-research/`，不进入发布包：

- `catalog-probe.mjs`：正负向探针；SHA-256 `997FB8956D2AFBD6D7E613BB83DAB7AD4DC7F6F775A485BC18F1DA58A07ACD3C`。
- `catalog-probe-result.json`：最后一次测试结果。
- `01501_codex-rs_models-manager_models.json`：官方版本目录快照；SHA-256 `EB0D7B9A5DCAF103895C5F8A14C16B269DF46E039B375A55BA97F6238542D2ED`。
- `01501_codex-rs_core_config.schema.json`：官方版本配置 Schema；SHA-256 `2B1906BB9F854E503A96E2DE47DBAD7F069A1DE3A929CA0E81E270CDCE4DFFEA`。

这些结果证明了特定配置下原生补丁拒绝和实际 MCP 查询成功，不等同于全业务验收、完整操作系统沙箱验收或安装包验收。

## 模型代理与配置归属约束

原生目录是第一层限制。严格只允许五个 ERP 工具还需要以下强制边界：

- 主机控制模型请求入口，只接受固定 Responses 路径及本任务短期凭据，不允许 WebSocket 或任意转发地址。
- 上游 `tools` 只保留当前任务的精确 ERP namespace/name；上游输出也必须独立校验，不能因为未向模型公布原生工具就信任其不会调用。
- 完整缓冲上游响应并完成结构与工具检查后，再发给 App Server。对 `function_call` 按精确 namespace/name 和参数检查；拒绝 `custom_tool_call`、本地 shell、工具发现、未知调用类型及未知事件。所有 SSE 事件中的 item、参数片段和最终 output 都须一致，不能只检查最后一个完成事件。
- 业务 MCP 服务不开放任意文件、通用 shell、代码求值、正式 commit 或替他人确认能力。每次操作重新核对主机绑定的人员、任务、模块与账本，不接受模型传入的人员或审批字段。
- 主机生成并覆盖 ERP 专属 catalog、config、provider、feature 集合、MCP 路径和工具集；客户端任务 API 不接受原始 Codex config、模型目录路径、命令、工作目录或环境变量。普通员工不能通过设置接口改写这些执行策略。
- 公司模型设置只能由管理员修改允许的业务字段。更换模型后必须生成同样受控的完整目录并重新验证；新会话不能加载以前未受控的 Codex 会话历史。
- 任务 profile 与会话目录由公司服务账户持有。Windows 上的 Node `mode: 0o600` 不是完整 ACL 隔离；如果员工也有公司主机的本地文件访问权，需要独立 OS 身份和 ACL，并用真实低权限账户验证目录不可修改。当前探针没有验证这一部署边界。

运行时组应把上述负向注入与正向查询固化为显式 opt-in 的本机协议回归测试；不应把文档中的一次成功当成后续所有版本的自动通行证。
