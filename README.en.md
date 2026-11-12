# Wucheng ERP

[简体中文（默认）](README.md) | **English**

A browser workspace for purchasing, sales, and business overview. Production uses the native app installed through the fnOS App Center and launched from the fnOS desktop. No Docker or separate ERP installation on your computer is required.

## Version status

Acceptance records as of November 12, 2026:

| Version | Status | Cainiao browser |
| --- | --- | --- |
| [0.15.6](https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/tag/v0.15.6) | Last verified production installation | Separate sales and overview profiles |
| 0.15.7 | Built and archived in a private release draft; not installed on production NAS | One Chromium session with controlled tabs for each module |

Candidate runtime commit: `aa6218c2f004c98b609b7ce97b91c91b55ef4ead`. The [full build](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/43155768567) recorded 962 passes, zero failures, and three conditional skips, including clean-runtime acceptance. The [archive job](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/43157591549) retained the matching FPK, corresponding source, and checksums. CI success does not mean production has been upgraded or replace collection acceptance with a real platform account.

## Using and updating fnOS

- Open ERP from the fnOS desktop. Desktop access allows all device users. ERP still validates the trusted fnOS entry and session; business passwords, reviews, and month locks remain active.
- Cainiao Login displays Chromium running on the NAS through bundled Xvfb, VNC, and noVNC. It does not use the separately installed fnOS Chrome app or require another browser container.
- Users complete login and human verification themselves. Version 0.15.7 shares the existing sales profile and preserves the old overview profile without merging cookie databases. Switching accounts affects both modules; verify the account before collection.
- Validate an isolated installation and backups before production upgrades. Reuse existing data, then check the program version, ledger identity, and data version hosting. Never replace existing ledgers with newly created empty ones.

See [Operations (English)](docs/operations.en.md) / [运行维护（中文）](docs/operations.md). Ledgers, attachments, login profiles, secrets, and backups must stay outside Git.

## Source development

Requires Node.js 24 or newer, npm, and Git. Distribution packages bundle their runtime. Development data is isolated from production ledgers.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd --prefix apps/purchase ci --ignore-scripts
npm.cmd --prefix apps/sales ci --ignore-scripts
npm.cmd --prefix apps/overview ci --ignore-scripts
npm.cmd run web:dev
```

Development entry: `http://127.0.0.1:28430/`; default data: `.codex-artifacts/web-dev/data`. For port conflicts, supply an independent development configuration and data directory: `npm.cmd run web:dev -- --config <config-path>`.

```powershell
npm.cmd run web:check
npm.cmd test
npm.cmd run test:purchase
npm.cmd run test:sales
npm.cmd run test:overview
npm.cmd run check:ui
```

Modules: `apps/purchase`, `apps/sales`, `apps/overview`; host and gateway: `server/`; shared protocols: `shared/`; shared styles: `ui/`. Warehouse and buyer-order export tools have separate projects.

## Documentation

- [Development (Chinese)](docs/development.md) · [Architecture (Chinese)](docs/architecture.md) · [Shared UI (Chinese)](ui/README.md)
- [Native fnOS build workflow](.github/workflows/fnos-native.yml) · [Acceptance rules (Chinese)](docs/verification.md)
- [Data version hosting (Chinese)](docs/data-version-operations.md) · [Historical migration record (Chinese)](docs/browser-only-migration.md)

Historical browser-service and migration documents provide background; use the operations guide for the current environment. Before removing old programs or test directories, verify running instances, mounts, and backup purpose. Do not run a global Docker prune or remove ledgers, the independent warehouse app, or other services. Keep source, lockfiles, runtime resources, and documentation in Git; deliver build artifacts through the release process.
