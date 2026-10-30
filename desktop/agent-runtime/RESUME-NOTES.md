# Runtime pause checkpoint

## Resumed implementation on 2026-10-29

The user explicitly resumed the rebuild. The following changes are implemented,
but remain untested until the single consolidated acceptance after code freeze:

- Legacy schedule marker and origin now persist `sourceOwnerId:null`, the real
  `adoptedBy`, `ownerMapping:'legacy-global-host-owner'`, and
  `engineMapping:'company-default'`. Repeat import fills missing provenance on
  retained markers without recreating deleted schedules or replacing adopters.
- Natural-language schedule preparation uses the same scheduler validation as
  commit. Only a persisted migration marker permits a retained 30-second rule;
  ordinary newly-created schedules still require five-field cron.
- Appended results tag issue source modules and resolve registered temporary job
  blockers only for the same module and job ID with explicit successful evidence.
  Unknown jobs, absent IDs, partial completion and unrelated blockers stay open.
  Resolved entries retain their original history, evidence digest and timestamp.
- `artifacts.preview` uses the same artifact existence/task access/trusted-UI
  checks as `artifacts.open`, delegating byte/type validation to the private host.
- Task artifacts now store their real invoking adapter/capability provenance.
  `context.resolveTaskArtifact(id)` is private, same-task only, rechecks the fresh
  actor's source-module scope plus real path/size/hash, and rejects legacy artifacts
  without trusted provenance for handoff (preview remains allowed separately).
- Result blocks carry trusted source module/capability and unique block IDs.
  Human `tasks.input` corrections validate the exact result/row/before-value
  through the shared correction helper, preserve a task audit record, invalidate
  the old review, and regenerate rather than mutating saved rows or commit data.
  A still-running engine turn is stopped before checkpoint reset to avoid queued
  tasks losing their executor. All of this remains pending consolidated testing.
- Backup listing/verification and reviewed `backups.restore-copy` now use the
  private host hooks. The signed plan binds backup ID, recovery ID and manifest
  SHA; receipt recovery cannot accept a different source/target or active ledger.
- A task now accumulates trusted `dataAccessRequirements` before tool events or
  artifacts are generated and when results are appended. Reads/list/history and
  artifact access recheck explicit roles, permission flags and data modules using
  the current actor and registered capability. Ordinary draft history does not
  acquire an implicit write-permission gate. Legacy block/step/event/effect
  provenance is checked; unattributed system results require a fully authorised
  administrator. All backup capabilities require access to all five data modules.
- `artifacts.preview` requires the current task ID; `artifacts.open` validates it
  when supplied, retaining compatibility with older downloads without task ID.
- `tests/agent-runtime-resume.test.mjs` contains the new consolidated regression
  cases; they were written but not run during this implementation phase.

The older checklist below describes the pause baseline, not current acceptance.

The user paused reconstruction to inspect an unfinished package. Do not interpret
this checkpoint as release acceptance. No tests or protocol probes were run after
the user's instruction to stop intermediate testing.

Completed earlier: persistent tasks, frozen human reviews, strict readback,
company Codex/Hermes adapters, private MCP, usage accounting, schedule migration
API, result history, assignment and task-bound attachments. Earlier evidence was
26 passing synthetic tests and actual installed-engine cancellation/restoration
against fake loopback model APIs; the later code has not been revalidated.

Latest code saved at pause:

- System `people.assignable` queries the private host extension of the same name.
  Contract: `{modules, name?}` plus verified actor/task context returns
  `{people:[{id,label,modules}]}`. Host must restrict to enabled editor/admin
  candidates with execution permission and all requested modules. Only these
  three fields are returned; name ambiguity requires `erp_ask`.
- Runtime has no public request operation for this private directory hook.
- Legacy schedule binding now has a stable internal migration task ID.
- Scheduler permits exact `*/30 * * * * *` only for trusted legacy import or
  already-marked migrated schedules; ordinary creation remains five-field cron.

Resume items, not implemented or not yet accepted:

1. Connect the host's trusted `listAssignableActors` implementation to the
   `people.assignable` extension. Until connected, the capability is unavailable.
2. Host requested explicit migration ownership provenance in both marker and
   schedule origin: `sourceOwnerId:null`, `adoptedBy:<real host actor>`,
   `ownerMapping:'legacy-global-host-owner'`, `engineMapping:'company-default'`.
   Current origin says creator unknown and records migrationOwnerId; the exact
   requested provenance fields still need aligning.
3. The system adapter's natural-language schedule update preparation still calls
   the standard five-field cron parser directly. Align it with the migrated
   30-second schedule path before claiming complete legacy update support.
4. Confirm host migration manifest shape and ownership mapping from actual Beta
   warehouse settings; never invent enabled defaults or revive deleted schedules.
5. Verify packaged external Python bootstrap and bundled MCP entry paths. Their
   trusted factory options exist, but packaged execution remains a release gate.
6. Complete full-module business acceptance, real company API acceptance, and
   final all-at-once regression after code freeze. An unfinished viewing package
   must remain isolated from formal writes and be labelled unfinished.

The formal original checkout, business databases, and personal AI profiles were
not changed by this runtime worktree.
