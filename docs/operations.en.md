# Operations

[简体中文（默认）](operations.md) | **English** | [Home](../README.en.md)

The last verified production installation is the native fnOS **Wucheng ERP 0.15.6**, launched from the fnOS desktop. Former Windows services and ERP Docker containers are no longer production or rollback entries. Keep program files, runtime files, ledgers, and backups separate.

## Environment

- App ID: `wuchengerp`; installation volume: storage space 4.
- Program: `/vol4/@appcenter/wuchengerp/erp`; runtime and logs: `/vol4/@appdata/wuchengerp/runtime`.
- Production ledgers, attachments, identities, month locks, and the original UVCS workspace: `/vol4/@wuchengerp-data/erp`.
- Pre-upgrade backups: `/vol4/@wuchengerp-data/backups/before-upgrade-*`. Keep full migration backups on their original backup volume and retain required rollback material.
- Native packages bundle Node.js 24.22.2, Chromium, Xvfb, noVNC, and all three modules. Retain host Tailscale and the official system UVCS CLI.
- Production ERP does not require Docker. Tunnel, router, Home Assistant, and independent warehouse services are outside ERP cleanup scope. Preserve their installations, authorization, and data.

## Access and browser sessions

In fnOS application settings, desktop access is set to all device users. The package uses `fnos.accessPolicy=fnos`, without a separate UID allowlist. Legacy `allowedUids` entries do not control access under this policy. Trusted fnOS Unix-proxy, origin, and session checks remain active, along with business reviews, passwords, and month locks.

All-user access was tested with an ordinary fnOS account on 0.15.5 across all three modules. Some Chinese display names have encoding issues; verify identity through the fnOS UID rather than treating a garbled name as a login failure.

Production 0.15.6 retains separate sales and overview browser profiles. Complete platform login in the relevant remote window, then connect from the business module. Both encrypted VNC connections, display, mouse, and keyboard were tested on the NAS. Users complete platform authentication themselves.

Candidate 0.15.7 has not replaced production. With `native.browser.shared=true`, both modules share the original sales Chromium profile and login state, while each owns a controlled collection tab. The old overview profile remains untouched; cookie databases are not merged. Both legacy login links open the same remote window. Switching platform accounts affects both modules, so collection verifies the task account each time.

Shared browser operations queue automatically, with connection and queue status displayed separately. Uncertain platform submissions retain a submission lease across restarts until the original task is reconciled. Jobs that already saved a unique platform task ID or direct download result recover lease release against their original module, job, and account. Do not delete `.shared-cainiao-submission.json` to bypass reconciliation. Reconnect when a collection page closes; if browser operations cannot stop safely, pause collection and restart through the native application lifecycle.

## Update procedure

1. Edit, check, and push source. Run `fnos-native.yml` with `check_scope=full` and `build_trial=true` for full tests and isolated packages.
2. Retain formal and trial FPKs, corresponding source, and checksums from the same commit and run. Verify `BUILD-INFO.txt`, SHA256, and runtime evidence; do not mix candidates.
3. Test ordinary-account access, real pages, and stop/start behavior in `wuchengerptrial`. Stop the trial before updating production to avoid resource contention.
4. Upload the formal FPK through App Center. Explicitly select reuse of installed native data, leave migration paths empty, and reuse the installed system CLI. The wizard may restore stale migration answers; recheck them.
5. Upgrade hooks stop writes, create a complete backup, and verify restoration in a copy before replacing the program. On failure, preserve data and backups. Never create empty ledgers, disable UVCS, or bypass validation.
6. Verify version, original serverId/dataSetId/fnOS instance, all three ledgers, data version hosting, and actual administrator and ordinary-user pages. Remove trial apps and temporary diagnostics only after acceptance and scope checks.
7. The manual archive job in `ci.yml` accepts a successful `promote_run_id`, exact `promote_sha`, and `promote_tag`. It verifies and archives five formal delivery files without rebuilding, overwriting, or publishing. Publish only after device acceptance, with the matching FPK and complete corresponding source.

0.15.7 runtime commit: `aa6218c2f004c98b609b7ce97b91c91b55ef4ead`. [Build 43155768567](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/43155768567): 962 passes, zero failures, three conditional skips; formal/trial and clean-runtime acceptance passed. [Archive 43157591549](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/43157591549) retained matching assets in a private draft. This proves candidate delivery, not a NAS upgrade. LAN and remote acceptance after installing 0.15.7 remains pending.

0.15.6 runtime commit: `d2d149ed55c17a013973323fed2184080af11ac4`; full build `43020163539`, archive `43022528644`. Later documentation or archive-workflow edits do not change the installed runtime provenance.

## Troubleshooting and rollback

Start with `/var/log/apps/wuchengerp.log` and `logs/native-supervisor.log` under the runtime directory. Preserve the earliest underlying error. Source-ledger checks may require existing WAL/SHM files; validate restoration using a copy. Do not create temporary files in production data or ignore WAL to claim integrity.

For a remote-browser connection failure, check the fnOS session, same-origin WebSocket, gateway-to-VNC handshake, and actual display separately. LibVNCServer requires an upstream Origin; 0.15.6 supplies a fixed local upstream Origin through the existing proxy library while stripping client credentials. Package acceptance includes actual RFB handshakes through both fnOS Unix-gateway VNC routes, rather than page-only or direct-port checks.

Older Chromium shutdown attachment timeouts could leave Singleton locks. Version 0.15.5 sends a normal close command to the current generation's unique debug address. After startup failure, inspect processes, ports, and locks before cleanup. Hold lifecycle and instance locks and verify UID, device, inode, target, and stale state. Do not kill processes broadly, recursively remove production directories, or run a global Docker prune.

Rollback requires a verified native FPK and compatible ledgers, not former Docker ERP containers. Once new business writes occur, never overwrite current ledgers with an old backup. Uninstall removes the program while preserving ledgers and backups by default. Data deletion requires an explicit scope.

## Latest entry, login, and cleanup checks — November 12, 2026

On 0.15.6, LAN HTTP desktop access and fnOS remote HTTPS access passed session, three-module-page, and both VNC checks. The earlier INVALID_HOST error did not recur; configuration and services were unchanged. Its root cause remains unknown. Record the exact URL and time if it returns; this is not evidence of a configuration fix. IP HTTPS with a certificate-name mismatch was not accepted as a working entry.

A real Cainiao account reached the business page and detailed bills after the user manually completed human verification in a fresh login flow. No profile reset, package installation, or ledger mutation occurred. Chromium GLX/WebGL was also unavailable, but no causal link to the original login failure has been established and no graphics fix was applied.

The four old shared folders wucheng-erp-acceptance, wucheng-erp-import, wucheng-erp-native-test, and wucheng-erp-runtime-test were absent from the current listing. Search returned only wucheng-erp-backups, which was preserved. No additional deletion occurred. Personal installation staging, migration, and diagnostic folders require separate inspection for backup and recovery material before removal.
