# @cavendo/mcp-server Changelog

## 0.1.0 (2026-02-18)

Initial release.

- MCP tools: `cavendo_list_tasks`, `cavendo_get_task`, `cavendo_claim_task`, `cavendo_update_task_status`, `cavendo_submit_deliverable`, `cavendo_get_context`, `cavendo_list_knowledge`
- MCP resources: project knowledge, task context
- Authentication via `CAVENDO_AGENT_KEY` (supports both `cav_ak_` agent keys and `cav_uk_` user keys)
- Deliverable submission with files, actions, and summary fields
- Token usage tracking (input/output tokens, provider, model)
