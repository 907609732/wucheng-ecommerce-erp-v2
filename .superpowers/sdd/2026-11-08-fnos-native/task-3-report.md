# Task 3 — Real-ledger native migration and retained-data reinstall recovery

Status: implementation and Windows verification complete; Linux changed-UID execution and real NAS acceptance remain pending. No NAS/browser/production access or build-script changes were performed.

Baseline: `3a269778ea22029634653b5229cec7585f30045e` on `codex/fnos-native`.

## Migration behavior

- Removed `remapReferences` and every business-database UPDATE from native migration. No trigger removal, unlock, fake SQL authorization function, or outbox/snapshot rewrite is used. `configureNative`'s interface is unchanged.
- Rebased only configuration/program/data directories. Relative original/evidence references keep their original strings and resolve through the copied directory layout.
- Read-only preflight uses the reviewed owning-module columns from `shared/data-version-policy.mjs`: purchase imports/attachments/images, sales imports/freight attachments, and overview imports.path. It additionally checks real workbench migration evidence local_path, sales platform reference JSON evidence_path, and overview payment evidence derived from validated metadata. Relative references must resolve to physical regular files under their owning copied module data directory. Payment evidence also checks its recorded digest/bytes.
- Unsupported POSIX/Windows absolute references, traversal, unsupported Linux backslash-relative paths, links, missing files and corrupt payment evidence fail before atomic publication. No speculative legacy root mapping was added. Actual NAS absolute-reference counts are still unknown; real stopped-copy preflight is required before cutover.
- Fresh/migrate initialization uses a private physical stable sibling `erp.configure-state/native-lifecycle.sqlite` transaction. SQLite releases ownership after process death. Each attempt owns only its new UUID staging directory; abandoned stages are never discovered and deleted by another attempt. Existing lifecycle state/ownership interfaces are unchanged.

## Regression evidence

The initial test run failed for the intended bugs:

1. The real module fixture, with data-version capture enabled, failed inside old `remapReferences` with `no such function: data_version_write_allowed`.
2. Real imports with unsupported absolute, traversal and missing original references were incorrectly accepted by old migration.
3. A killed initializer left the old mkdir `.configure-lock`; retry failed with EEXIST.

The fixture now constructs a complete stopped source using all three real module `openStore` implementations. It saves actual original bytes/import rows, enables real capture/outbox/snapshots, sets an actual shared month administrator password, uses actual `lockScope` and `lockMonth`, and verifies that both kinds of imports reject UPDATE with MONTH_LOCKED. It demonstrates the independent naked SQLite capture-function failure as well.

Before reopening migrated application stores, it checks SHA256 equality for every retained source file except the deliberately rebased config and source manifest. This includes business DBs, DB-contained audit/outbox/locks, all snapshots/blobs/originals and state/month-admin.sqlite/identity. It checks unchanged source hashes, then successfully reopens the migrated sales store with capture enabled and verifies the original password and both locks. This is capture testing, not a claim of real authenticated UVCS upload or real cm availability.

The old dummy native_attachment_fixture was replaced with an actual purchase imports row and existing original file. Additional tests explicitly reject absolute overview imports.path and embedded sales platform evidence references.

## Bounded root setup recovery

- Added `cmd/retained_recovery.py`, invoked only by install/upgrade hooks through system `/usr/bin/python3 -I -B`. The shell validates the helper and every physical ancestor as root-owned and non-writable by group/other before execution. Payload Node and package-writable target code never run as root.
- The hook operates only on exact physical `VOLUME/@wuchengerp-data/erp`, `backups`, and the designated private `erp.configure-state` sibling. It never recursively chowns target or a selected migration source. Normal main start/status/stop do not call recovery.
- Uses system POSIX no-follow dirfd operations, inode/device checks, BASE-inode flock, full inventory checks, no cross-filesystem traversal, no special-device traversal, and no-follow ownership changes. Internal immutable snapshot hardlinks are accepted only when all links are accounted for inside the inspected trees; external hardlinks are rejected. Traversal keeps descriptors bounded by depth rather than the number of snapshot directories.
- Reads known runtime records, including nested child PID fields; live, malformed or uncertain records fail before ownership changes. Exclusive SQLite lifecycle/ownership transactions remain held through repair, and busy locks fail before chown. The whole inventory and file identity/size/mtime are rechecked before repair. It never kills a process or repairs arbitrary stale runtime records.
- Recognized abandoned UUID staging directories and the obsolete exact `erp.configure-lock` directory remain untouched, including their old owner and contents. Other unknown BASE entries refuse recovery for manual inspection.
- Install callbacks choose existing mode when the retained config exists. Upgrade init explicitly stops native services before its existing stopped backup. Uninstall already stops native services before retaining the data and remains unchanged.

System `/usr/bin/python3` is a deployment prerequisite for these root setup hooks. Its actual NAS availability must be checked by the build/deployment owner; this task did not access the NAS or install anything there. The trusted cmd path's real fnOS ownership/layout also needs packaged/real-host verification; if it is package-writable, execution refuses rather than running as root.

## Verification

- Requested combined command `node --test tests/web-fnos-native-migration.test.mjs tests/web-fnos-native.test.mjs`: latest combined run **23 total, 21 pass, 2 Linux skips, 0 fail** (158 seconds). Log: `task-3-focused-latest.log`.
- Final current migration file after additional overview/JSON/state assertions: **8 total, 7 pass, 1 Linux skip, 0 fail** (25 seconds). Log: `task-3-migration-latest.log`.
- Narrow actual module checks plus migration: **13 total, 12 pass, 1 Linux skip, 0 fail**, including all six `apps/sales/test/scoped-locks.test.mjs` checks.
- Full `npm test` rerun: **236 total, 220 pass, 16 skips, 0 fail** (198 seconds). Log: `task-3-full-test-rerun.log`. This broad run began before the final extra overview/JSON test was added; that added test passed separately and in the final migration run.
- The first broad run had **219 pass, 1 fail, 16 skips**: the new C:\\old reference test failed during unnecessary fresh source bootstrap with `purchase: 启动进程尚未就绪，不能进入备份窗口`, before exercising migration. Source fixtures were changed to real `openStore` setup without starting unrelated services; rerun is green. The original failed log is retained as `task-3-full-test.log`.
- Git Bash `sh -n` on all shell cmd files: pass. System Python AST/compile syntax checks on helper and integration test: pass. `git diff --check`: pass (normal repository CRLF conversion notices only).

## Explicit remaining acceptance

1. `tests/fnos-native-retained-recovery.py` contains isolated Linux/root cases using old UID/GID 42001 and replacement 42002: retained original/password/lock bytes, internal snapshot hardlinks, live/malformed/nested PID refusal, busy SQLite lock refusal, symlink/external hardlink/unknown BASE refusal, and abandoned-stage/legacy-lock preservation. These were **not executed on Windows**; no Linux UID proof is claimed. `tests/web-fnos-native-migration.test.mjs` invokes them on Linux (direct root or `sudo -n /usr/bin/python3`). Linux CI must run them before acceptance.
2. Current machine has Node 24.18.0, Git Bash and Python; WSL has no installed distribution. No fake Linux emulation was used.
3. No real NAS absolute-reference census, stopped-copy migration, cm/HOME/account check, UID-changing reinstall, fnOS hook trust/layout, package installation, browser login, production cutover or rollback was performed.
4. Recovery intentionally refuses uncertain live/PID-reuse records and unknown retained BASE content. Such data requires operator inspection; it is never silently deleted, unlocked or changed to force installation.

## Late requested fresh relay boundary

The parent added the fresh `Host: localhost` / no Origin boundary after the migration/full-suite checks above. Inspected the existing `fnosIdentity`/`validateFnos` implementation first. A new real fresh-config regression failed with INVALID_HOST before the fix. The minimal fresh-only change explicitly maps `localhost` to the validated primary HTTPS publicOrigin and adds that canonical primary to the supplied allowedOrigins. It does not inspect Forwarded/X-Forwarded-Host, add arbitrary host trust, or change migration aliases. The install wizard now calls the field the primary fnOS relay HTTPS origin and explains that it excludes the application path.

The regression verifies no-Origin identity resolution and Secure identity, secondary allowlist retention, untrusted Host plus forwarding-header refusal, mismatched Origin refusal, and retained migration hostAliases. Existing serialized-origin-update fixtures now keep the primary origin while adding the secondary origin, as the existing strict alias validation requires; production existing-mode validation was not weakened or altered.

Final relevant command: `node --test --test-name-pattern='fresh resolves the exact localhost|existing configure waits|real package configure CLI|relay Host aliases' tests/web-fnos-native.test.mjs tests/web-fnos.test.mjs`: **4 pass, 0 fail**, 38 seconds (`task-3-relay-targeted.log`). A combined and a broad run had already started before the parent said a further full run was unnecessary, and before those two origin-update fixtures were adjusted; those runs can show the two expected stale-fixture failures. Their final results will be appended when they finish. The last completed pre-relay broad suite remains the green 220/16 run documented above.

Those in-flight runs have now finished: combined migration/native/identity **39 total, 27 pass, 2 fail, 10 skips**; broad npm **238 total, 220 pass, 2 fail, 16 skips** (214 seconds). Both failures are exactly the old input variants of `existing configure waits for the lifecycle transaction and merges independent updates after reload` and `real package configure CLI preserves independent updates with one serialized browser-required commit`. They loaded before the final fixture correction and rejected removal of the primary destination still referenced by the fresh relay alias. Both corrected tests, the new no-Origin fresh test and the existing alias security test passed together in the final targeted run above. No additional failure appeared. These intermediate runs are not described as a green final full suite; the current source requires normal CI verification.

## Task 3 fix round 1 — review Important 1 and 2

Read the full `task-3-review.md` and the owning UVCS/start record producers before changing code. Scope is only the two recovery security findings and their direct regressions; no full-suite rerun, NAS access or build changes.

1. **Unpublished launches are uncertain.** The real `stopped_record` parser now rejects an ownerPid with missing/null childPid, and rejects null/malformed values for any published PID field. It does not treat a dead launcher as proof that its unpublished child stopped. A portable test executes the actual parser extracted by Python AST with only its OS liveness probe supplied as a dead-process result. Before the fix all three actual-shaped UVCS/start missing/null-child cases failed to raise (RED); after the fix all raise (GREEN). Linux integration additionally asserts no retained ownership changes for both command-lease.json and .integration-start.lock cases.
2. **Ownership mutation is inode-bound.** Each leaf is opened with Linux `O_PATH | O_NOFOLLOW | O_CLOEXEC`; its fstat is validated against inventory, then system libc `fchownat(fd, "", uid, gid, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW)` changes that descriptor's inode. No leaf pathname is used for the privileged ownership syscall. This supports regular files, directories and stale Unix sockets. Descriptor and published-path checks after the syscall detect substitution/unlink; failures never cause a replacement outside inode to be chowned. BASE ownership still uses its originally opened no-follow directory FD.

**Concurrent hardlinks require a separate writer boundary.** Merely pinning an FD does not stop its owner from adding an outside hardlink to the same inode after link-count validation. Recovery therefore requires BASE already private (0700 access), retained entries not writable by group/other, Linux protected_hardlinks=1, and no process/thread retaining any real/effective/saved/filesystem UID from the target package UID or non-root retained-tree owners. The read-only `/proc/PID/task/TID/status` census checks all four UID fields. Root-owned retained items do not require root administrators to log out: UID 0 is excluded from the owner set. A reused non-root UID that has tasks is refused with the UID and task number; nothing is killed or forcibly logged out. Ordinary migration copies are package-owned, so source-owner NAS administrator sessions do not enter this retained-tree owner set.

The trust premise, agreed with the controller, is that appcenter serializes privileged installation and lifecycle transitions, existing SQLite lifecycle/ownership transactions stay held through repair, and root/CAP_SETUID actors are trusted. When no task has any owner real/effective/saved/fs UID, an untrusted process has no owner task from which to fork or regain that UID. Private BASE plus non-public write modes and protected_hardlinks deny other unprivileged UIDs link authority. A new root credential transition or malicious root filesystem mutation is outside this non-root adversary model; repeated process scans would not make root behavior atomic. This is explicitly a prerequisite, not a claim that a process census is a kernel-wide root freeze.

**Bounded cost:** exactly three complete thread censuses (after inventory/link checks, immediately before mutation, and after mutation), rather than one per file. Each entry retains its FD/inode checks. Complexity is O(E × directory-depth + 3 × T), where E is retained entries and T is current system threads; descriptor use stays bounded by traversal depth plus the few SQLite lock handles. For 100,000 entries and 1,000 threads this means 3,000 status reads, not 100,000,000. Tree metadata traversal and chown still scale with the retained tree and NAS I/O; no real NAS timing is claimed. A Linux test with 64 extra files asserts that full census count stays at most three.

**New Linux regressions:** deterministic replacement at the actual ownership syscall boundary (old pathname implementation changes an outside inode; descriptor implementation leaves the outside owner/bytes untouched and refuses the substituted tree), an active old-UID process refusing before any ownership change, stale socket/directory descriptor ownership, unpublished-launch no-chown cases, and the bounded census case. These join the previous changed-UID/bytes/hardlink/unknown-tree tests.

**Local verification:** `python tests/fnos-native-retained-recovery.py`: 11 tests, **1 parser pass, 10 Linux/root skips**, no failures. `node --test tests/web-fnos-native-migration.test.mjs`: **7 pass, 1 Linux skip**, 26.6 seconds (`task-3-fix1-migration.log`). Python AST syntax checks and `git diff --check`: pass. Linux syscall/substitution/UID execution is **pending CI for this fix**; the controller reported the prior-version Linux job 42503071867 passed, which is not evidence for these new fixes. No Windows UID emulation or Linux success claim is made.
