# Business runtime slimming — 0.11.8

Branch: codex/business-runtime-slimming. Formal ledgers and installed formal application are not modified.

## Implemented, awaiting unified verification
- Removed embedded Codex/Hermes runtime, model proxies, conversation UI and engine dependencies.
- Retained purchase, sales, overview, warehouse, exporter, human review and external MCP/CLI.
- Consolidated purchase/sales/overview into one Node host with independent workers and ledger paths.
- Added dependency integrity cache, preserving critical-entry hashing and full update/periodic verification.
- Shared dependency layers use hardlinks where supported; package trace excludes unused runtime resources.
- Cached business views, coalesced loading, paused hidden-page refresh, paginated review results.
- Preserved module backup/restore and source provenance; removed unused autonomous-task backup code.
- Removed warehouse attendance/configuration/reminders, preserved historical records and sync evidence.
- Isolated test ledgers disable automatic scheduled outbound work.

## Unified verification gate
Pending: syntax and integration suites; actual packaged module dependency regression; installer build; clean installation; cold/warm startup; four business screens; external MCP/CLI and human review; formal-data isolation; artifact size/hash and rollback report.

## Data boundaries
Use the existing independently identified preview profile WuchengAgentBeta-preview and appId com.wucheng.ecommerce.erp.v2.agentpreview. Never redirect it to formal data. Preserve prior preview data before replacing test copies. No production migration or main-branch merge is part of this build.
