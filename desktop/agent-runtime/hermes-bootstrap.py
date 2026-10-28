"""Use the installed Hermes ACP server with an ERP-only agent factory.

The installed Hermes source is never patched. This compatibility adapter is
locked to the tested version and removes native coding tools at construction
and after each MCP refresh, not merely through prompt instructions.
"""
import asyncio
import os
import sys

root = os.environ.get("ERP_HERMES_ROOT", "")
if not os.path.isdir(os.path.join(root, "acp_adapter")):
    raise RuntimeError("Installed Hermes ACP adapter not found")
sys.path.insert(0, root)

import hermes_bootstrap
hermes_bootstrap.harden_import_path()
from acp_adapter.entry import _setup_logging
_setup_logging()

import acp
from acp.schema import ModelInfo, SessionModelState
from acp_adapter.server import HermesACPAgent
from acp_adapter.session import SessionManager
from run_agent import AIAgent

PREFIX = "mcp__wucheng_erp__"
ALLOWED = {PREFIX + name for name in ("erp_capabilities", "erp_query", "erp_prepare", "erp_task_result", "erp_ask")}

def verify_tools(agent):
    names = {tool.get("function", {}).get("name") for tool in agent.tools}
    if not names or not names.issubset(ALLOWED):
        raise RuntimeError("ERP_TOOL_ISOLATION_FAILED: unexpected Hermes tool catalog")
    agent.valid_tool_names = names

class ErpAgent(AIAgent):
    def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
        # Check before upstream sequential/concurrent/inline dispatch. Some native
        # inline tools bypass the registry's enabled_tools check.
        verify_tools(self)
        for call in assistant_message.tool_calls or []:
            if self._get_tool_call_name_static(call) not in ALLOWED:
                raise RuntimeError("ERP_TOOL_ISOLATION_FAILED: model requested an unauthorized tool")
        return super()._execute_tool_calls(assistant_message, messages, effective_task_id, api_call_count)

class ErpSessions(SessionManager):
    def _make_agent(self, session_id=None, cwd=".", model=None, **kwargs):
        # A nonempty MCP-only toolset prevents the upstream ACP fallback to hermes-acp.
        return ErpAgent(
            model=model or os.environ["ERP_COMPANY_MODEL"],
            api_key=os.environ["ERP_COMPANY_API_KEY"],
            base_url=os.environ["ERP_COMPANY_BASE_URL"], provider="custom",
            enabled_toolsets=["mcp-wucheng_erp"],
            disabled_toolsets=["terminal", "file", "browser", "web", "code_execution", "delegation", "skills", "cronjob", "memory"],
            session_id=session_id, session_db=self._get_db(), platform="acp",
            skip_context_files=True, skip_memory=True, skip_background_review=True,
            load_soul_identity=False, quiet_mode=True, max_iterations=40,
            checkpoints_enabled=False, save_trajectories=False,
        )

class ErpAcp(HermesACPAgent):
    def _build_model_state(self, state):
        # The upstream picker inventories all local providers (including OS
        # keychain-backed gh auth). ERP has exactly one company provider.
        model = os.environ["ERP_COMPANY_MODEL"]
        return SessionModelState(available_models=[ModelInfo(model_id=model, name=model)], current_model_id=model)

    def _switch_model(self, *args, **kwargs):
        raise RuntimeError("Company model selection is controlled by ERP settings")

    async def set_session_mode(self, *args, **kwargs):
        raise RuntimeError("ERP execution permissions cannot be changed by a session")

    async def set_config_option(self, *args, **kwargs):
        raise RuntimeError("ERP execution configuration is controlled by the host")

    async def _register_session_mcp_servers(self, state, mcp_servers):
        if any(server.name != "wucheng_erp" for server in (mcp_servers or [])):
            raise RuntimeError("Unexpected MCP server")
        await super()._register_session_mcp_servers(state, mcp_servers)
        verify_tools(state.agent)

    async def prompt(self, session_id, prompt, **kwargs):
        state = self.session_manager.get_session(session_id)
        if state is None:
            raise RuntimeError("Unknown ERP session")
        verify_tools(state.agent)
        # Do not let slash commands change the tool/model policy through user data.
        if any(getattr(item, "text", "").lstrip().startswith("/") for item in prompt):
            raise RuntimeError("ERP session commands are controlled by the host")
        return await super().prompt(session_id=session_id, prompt=prompt, **kwargs)

if __name__ == "__main__":
    asyncio.run(acp.run_agent(ErpAcp(session_manager=ErpSessions()), use_unstable_protocol=True))
