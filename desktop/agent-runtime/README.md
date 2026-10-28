# ERP Agent runtime

Host entry point: `createAgentRuntime(options)` from `index.mjs`.
The host injects `resolveActor`, `secretStore`, `signApproval`, domain `adapters`,
`engines`, and private `extensions`. Public callers use
`request(operation, payload, {actor, trustedUi})`; identity is refreshed from the
host on every request, tool call, and commit. Responses are raw objects; errors
carry `code` and `statusCode`. The renderer cannot provide trusted identity.

## Domain adapter

An adapter owns `id`, `capabilities`, `binding(ctx)`, `query(id,input,ctx)`,
`prepare(id,input,ctx)`, `commit(step,ctx)` and `receipt(idempotencyKey,ctx)`.
Each capability declares `id`, `title`, `kind`, JSON `inputSchema`, optional
`roles`, `available` and `requiresReview`. Schema validation runs before calls.
Context includes the verified actor and capability, task ID, abort signal,
events, task-bound `resolveAttachment(id)` and `registerArtifact(record)`.
Models receive attachment metadata and IDs, never host paths or credential files.

Queries return `{summary, blocks, evidence, issues?}`. A formal preparation adds
`changes` and private `commitData`. Its dataset, revision, input and change digest
are frozen. A safe automatic preparation must declare `requiresReview:false`
both in capability and output, and cannot return `changes` or `commitData`.

Only a trusted UI review of the exact result version can request a signed commit.
`approval.mjs` verifies all actor/task/result/dataset/revision/digest/operation
bindings. Domain endpoints must verify the full expected binding, store the
idempotency key transactionally with their write, and reject replay mismatches.
The model-facing MCP has no approval or commit tool.

Commit must return a receipt. Completion additionally requires readback:
`{state:'completed'|'confirmed', idempotencyKey, receipt}`. Pending, processing,
partial and unknown receipts do not complete a task. Unknown writes are only
reconciled; they are never replayed. If an earlier write changes a later step's
revision, the remainder is prepared and reviewed again. Pause preserves review.

## Common tasks and permissions

Authenticated enabled users may create query goals. The model only sees their
permitted capabilities. Writes require editor/admin and `canRunTasks`, except
the exact warehouse self-service attendance check-in/complete capabilities;
those require editor/admin and the same person must approve their own task.
Schedules still require execution permission. Current permissions are checked
again after assignment, at every scheduled run and before every commit.

The system adapter supports schedule query/create/update/delete, assignment,
admin permission query/update and verified automatic backup. Permission inspect
and receipt hooks are internal only. File-based permission writes use the host's
atomic policy+receipt envelope. SQLite schedule/assignment writes and receipts
share a transaction. Backups are advertised only when the host hook exists.

## Engines

Codex uses the installed official App Server, exactly version 0.150.1. The
company profile uses the bundled official model metadata with native shell,
patch, web and computer tools disabled. Only five named ERP MCP tools are
approved. A private HTTP proxy filters input tools and buffers/validates every
model output before App Server sees any tool call. WebSockets are disabled.
Unknown models fail before task execution; `status.engines[].supportedModels`
exposes the list. Model settings cannot override profiles, tools or executables.

Hermes uses official ACP v1 through `@agentclientprotocol/sdk`, with a small
subclass of its official Python ACP server and agent factory. Version 0.21.0 and
critical source SHA256 fingerprints are pinned in `hermes-compatibility.json`.
Only the ERP MCP toolset is constructed and checked before prompt and dispatch.
The model picker is company-only, avoiding personal provider/keychain discovery;
automatic title inference is disabled. Personal engine configuration is untouched.

Both engines use private HOME/config/session directories. This is application
tool isolation, not an OS account sandbox against a malicious local process
already running as the host Windows account. Such a process has OS-level rights
outside the application's remote employee boundary.

## Persistence and usage

One process owns the task SQLite database. Restart pauses in-flight engines,
marks interrupted commits unknown, and marks pending usage unknown. Schedule
occurrence claims and task inserts share a transaction. All use full-sync WAL.
Task attachments are limited to 50 MiB each and 20 per request, have real byte
SHA256 hashes, and are resolved only when bound to the authorized task.
Registered artifacts expose metadata without internal paths.

Local token budgets are admission control, not a promise of provider billing
limits. A finite budget reserves its remaining balance for one active request;
unknown usage blocks additional budgeted runs. Provider usage events are saved,
including Codex responses rejected by the tool gate. Errors/cancellation do not
become zero usage. Provider-side company quota remains the final hard limit.

## Verification

`node --test tests/agent-runtime*.test.mjs` uses temporary synthetic ledgers.
`node tests/agent-runtime-live-protocol.mjs --codex` and `--hermes` run the actual
installed protocols against a fake loopback model API and actual ERP MCP bridge.
`--attack` injects a forbidden native tool; Hermes also accepts `--inline-attack`
to inject delegation. `--cancel` interrupts an in-flight model request, closes
the engine process and restores its actual persisted session for a second turn.
`--resume` tests normal cross-process continuation. Codex enables the documented
experimental API negotiation for its pinned version's `thread/resume.excludeTurns`.
No real company API, formal ledger, login or external
message is used by these probes. These checks do not establish full module or
packaged installer acceptance; that remains the integration release gate.

Packaged hosts inject trusted `mcpEntryPath` into both factories and a real
`bootstrapPath` into the Hermes factory. System Node and Python cannot read ASAR
paths. The builder must place the bootstrap and the bundled MCP entry outside
ASAR. Hermes verifies the external bootstrap bytes against this source version;
the packaged MCP entry must be bundled with its SDK dependencies and tested by
the release suite. Neither path is accepted from task or company settings input.
