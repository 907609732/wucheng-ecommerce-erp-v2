# Shared Cainiao browser implementation plan

> For agentic workers: use subagent-driven-development for bounded implementation and fresh whole-branch review. The user approved this design and requested a rebuilt package.

**Goal:** Sales and overview share one native Chromium/login while retaining separate automation tabs and safe coordinated collection.
**Architecture:** Reuse the existing pinned Playwright MCP 0.0.83, CDP, ws, noVNC and native lifecycle. Explicit shared mode aliases both module endpoints to the sales physical instance/profile. One collector owns an abortable FIFO operation queue and submission lease.
**Tech Stack:** Node 24, existing MCP SDK/Playwright, Fastify, native Chromium/Xvfb/x11vnc.
**Spec:** Approved user request and the Design section below.

## Design and global constraints
- Repackage only: no installation, production NAS/config/book modification or public release.
- Set native browser.shared=true in packaged configuration; legacy configs without it retain independent mode.
- Shared uses existing sales profile, ports/display; overview profile stays untouched. No profile database merging or deletion.
- Keep both authenticated VNC routes; exact Origin/path and credential stripping remain.
- CDP adapters create module-owned tabs and resolve the stable target each operation. Never use a neighboring fallback page. Windows extension behavior remains.
- Connect/run/disconnect serialize in shared native collector. Never release an active slot while timed-out code may still control a page. Failed isolation poisons the queue.
- Across RPCs hold a submission lease from baseline read through first unique remoteTask binding. Persist submittedAt before submit; uncertain submissions are recovered by querying, never retried.
- Queued HTTP cancellation/deadline removes pending work. Disconnect/shutdown cancels pending work without deadlocking active leases.
- Download hooks cover only the owned page and its popup descendants.
- Shared cookie/localStorage and distinct tabs must be tested; native smoke keeps sandbox, RFB input and persistence checks.
- No new runtime dependencies or NAS Docker containers.

## Review focus
- A user closes one automation tab: the other module must never be navigated or closed.
- Same account/month in both modules: remote task identity cannot cross-bind.
- Queue wait expiry or caller disconnect: a later invisible submit must never execute.
- MCP timeout while remote code runs: stop only that adapter/target and confirm isolation before allowing the next.
- Clean packaged runtime: one physical business browser, both VNC aliases and restart login retention.

### Task 1: Native shared instance and real package smoke
Files: server/fnos-native/browsers.mjs, lifecycle/configure/supervisor as needed, deploy/fnos/smoke-native.mjs and native tests.
Interfaces: nativeBrowserSpecs returns sales/overview aliases with explicit physical identity; browser.shared=true enables sharing. supervisor exports LINGTU_SHARED_BROWSER=1 for collector.
- [ ] Add failing tests for one physical launch, endpoint aliases, old overview profile preservation, legacy mode.
- [ ] Implement shared physical specs/start/status while retaining validations, generation ownership and sandbox.
- [ ] Update real smoke to verify distinct module tabs share storage; both VNC routes; real RFB keyboard/pointer without self-recursive viewer.
- [ ] Run targeted tests and syntax checks; report red/green evidence.

### Task 2: Owned tabs and isolated downloads
Files: both module CainiaoBrowser/page adapters, small shared CDP helper if useful, adapter tests.
Interfaces: existing connect/disconnect/run methods unchanged. disconnect must throw if it cannot prove timed-out execution isolated; collector then blocks future work. Native mode uses owned target; Windows extension unchanged.
- [ ] Add failing tests for owned page selection, closure/reconnect, sibling protection and popup download filtering.
- [ ] Implement stable target resolution each operation, owned-tab cleanup, timeout teardown with child-exit/target-closure proof.
- [ ] Use existing public CDP/Playwright APIs; no new dependency. Preserve browser/context and unknown profile tabs.
- [ ] Run targeted tests and syntax checks; report evidence.

### Task 3: Collector queue and submission lease
Files: server/collector.mjs, collector-client.mjs, new focused scheduler module/tests, both business managers.
Interfaces: CollectorBrowser.acquireSubmission(signal?) -> async release function; optional method in managers to preserve existing injected browser tests. A module-scoped opaque lease is included automatically on run calls; invalid/expired token fails closed. Queue uses absolute per-request deadline and cancellation.
- [ ] Add failing FIFO/cancel/lease/deadline/shutdown tests and manager submission ownership tests.
- [ ] Implement abortable queue, cancellation and bounded leases, module status for waiting and error messages.
- [ ] Hold lease before baseline and until unique remoteTask assignment, release finally on all exits. Keep unresolved submission block until recovery so a later same-account submission cannot cross-bind.
- [ ] Run root and both module targeted tests; inspect integration boundary with Tasks 1/2.

### Task 4: UI, verification and delivery
Files: native-browser.html/js, relevant docs, package versions/lockfiles.
- [ ] Apply reviewed minimal shared-login wording and one login entry while retaining legacy module URLs.
- [ ] Fresh review; fix important findings with regression tests.
- [ ] Set 0.15.7, run appropriate suites, commit/push feature branch and dispatch full native GitHub build with trial.
- [ ] Require successful full CI and real normal/clean-runtime smoke; download same-run FPK and verify SHA/BUILDINFO.
- [ ] Provide package/build evidence, leaving production NAS unchanged; keep entry configuration follow-up explicit.

