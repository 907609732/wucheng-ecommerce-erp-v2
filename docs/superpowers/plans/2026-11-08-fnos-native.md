# 完整飞牛原生 ERP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 构建并迁移到不依赖 Docker 的完整飞牛 ERP 应用，保留账本和 Tailscale。

**Architecture:** 官方 Native FPK 管理私有 Node、ERP、采集和原生浏览器。应用持久数据独立于 target，通过停写副本迁移，统一网关和 Tailscale 指向同一实例。

**Tech Stack:** Node 24、SQLite、fnpack 1.2.3、Debian bookworm-security Chromium + 锁定的 Playwright MCP CDP、Xvfb/x11vnc/noVNC、Fastify 代理。

**Spec:** docs/superpowers/specs/2026-11-08-fnos-native-design.md

## Global Constraints

- 不依赖 Docker；不修改或删除其他 Docker 应用。
- 长期服务为专用 package 用户；仅准备操作可特权执行。
- 保留现有 serverId/dataSetId、锁、密码、审计、附件、UVCS 队列与 HOME；Tailscale 127.0.0.1:28430 不变。
- 迁移缺失账本必须拒绝；新安装须显式初始化；默认卸载保留账本。
- 运行文件与持久数据分离；可分发包无用户数据/凭据；x86 包不能标 all。
- 使用官方 fnpack 和成熟浏览器/远程桌面/反向代理组件，不实现这些协议。
- 正式账本只做迁移及只读验收，不用于业务写入测试。

## Review Focus

- PID 重用、旧 generation 和并发 start 不得杀掉其他进程；Task 1 行为测试。
- 迁移源缺失/链接/仍运行/复制失败不得初始化空库或修改源；Task 1 行为测试。
- 匿名、跨站、伪造身份或任意代理目标不得控制浏览器；Task 2 HTTP/WS 测试。
- NAS 私有 ELF 依赖、字体和 Chromium sandbox 不满足时明确失败；Task 3 CI + NAS 检查。
- 升级/卸载不丢数据，旧 Docker 与新服务不能同时写入；Task 1 + 4 隔离验收。

### Task 1: 原生初始化、生命周期与持久数据

**Files:** Create `server/fnos-native/configure.mjs`, `server/fnos-native/supervisor.mjs`, `server/fnos-native/lifecycle.mjs`; modify `server/config.mjs`, `server/runtime.mjs`, `server/gateway/gateway.mjs` for optional `tcpEnabled=false` (default true for existing deployments), `deploy/fnos/wuchengerp/cmd/*`, `config/privilege`, `config/resource`, `wizard/install`, `wizard/config`, `wizard/upgrade`, `wizard/uninstall`; tests `tests/web-fnos-native.test.mjs`, replace thin-only responsibilities in `tests/web-fnos-package.test.mjs`.

**Interfaces:** `configureNative({releaseRoot,dataRoot,mode,sourceRoot,allowedOrigins,allowedUids,publicOrigin,instanceId,socketPath})` asynchronously returns persisted config file path; mode `fresh|migrate|existing`. CLI lifecycle `node server/fnos-native/lifecycle.mjs start|stop|status|configure --config <absolute>`. supervisor CLI `node server/fnos-native/supervisor.mjs --config <absolute>`, config stores optional `native.browser` payload passed to Task 2 `createNativeBrowsers(config,{logger})` with `start()/stop()/status()`. Defaults no browser in unit fixture; real FPK requires browser ready. Native executable defaults `process.execPath`; `native.home` for UVCS; native supervisor starts existing createWebRuntime and startCollector in one owned generation.

- [x] Write failure tests for explicit fresh creation, fnOS-only fresh mode with TCP disabled and genuine configured HTTPS NAS origin (no fake Tailscale placeholder), migration no writes to source, identity/locks/month-admin preservation, missing DB refusal, immutable paths, existing reconfigure preservation, concurrent lifecycle/PID identity protection. Supervisor IPC/status supports Unix-only health without forging user identity.
- [x] Run tests to see expected missing implementation failures.
- [x] Implement bounded lifecycle, exclusive lock and owned process control, generated production configuration, fresh bootstrap through isolated development then production, copied migration with original gateway/state/UVCS preservation and stopped source requirement. Upgrade hooks backup safely, default uninstall retains data. Root shell drops to package user and errors to TRIM_TEMP_LOGFILE; do not delete ledger or arbitrary paths.
- [x] Run `node --test tests/web-fnos-native.test.mjs tests/web-fnos-package.test.mjs tests/web-fnos*.test.mjs` (Linux-specific tests may skip Windows, must run CI later); run shell syntax checks. Commit task.

### Task 2: 原生浏览器与已认证登录界面

**Files:** Create `server/fnos-native/browsers.mjs`, `server/fnos-native/browser-routes.mjs`, `server/public/native-browser.html`, `server/public/native-browser.js`, `server/public/native-browser.css`; modify `server/fnos-native/supervisor.mjs` only for browser integration, `server/gateway/fnos.mjs`, `server/gateway/gateway.mjs`, `server/runtime.mjs`, `server/release.mjs`, `server/public/shell.js`, `server/public/index.html`, `package.json`, `package-lock.json`; update Linux connection hints in both Cainiao browser adapters; tests `tests/web-fnos-native-browser.test.mjs` and auth upgrade integration.

**Interfaces:** Produce `createNativeBrowsers(config,{logger})` => `{start,stop,status}` for two independent displays/profiles/CDP ports 19222/19223. Config `native.browser={enabled:true,runtimeRoot,chromiumPath,novncRoot}` paths resolved by package, display/VNC ports chosen internally from fixed safe range. Register native login views at `/web/native-browser.html?module=sales|overview`, static noVNC assets under `/web/novnc/`, authenticated WS route `/api/workbench/v1/native-browser/:id/websockify`. Existing gateway session/identity validation and strict Origin bound to actual public entry; FN Unix upgrade context only from real listener. Use maintained Fastify HTTP proxy with WS support to loopback x11vnc native WS; no custom RFB implementation.

- [x] Write failure tests for two profiles and loopback launch args, owned shutdown, allowed-target whitelist, unauthenticated/cross-Origin websocket rejection, FN/Tailscale identity behavior.
- [x] Run tests and implement native browser process launch with private runtime libraries, X11 auth, CDP loopback, bounded readiness and failure cleanup. Browser control page reuses noVNC and current public prefix; expose clear authenticated sales/overview browser links with existing shared UI tokens.
- [x] Wire supervisor and gateway registration; no effect when native browser disabled. Run relevant tests and prefix tests; commit task.
- [x] Use `@fastify/http-proxy@11.6.4` with actual WS upgrade authentication tests, including true Unix listener transport. Browser chooser reuses upstream noVNC `vnc.html` rather than creating a VNC client. Default fixed production CDP19222/19223, trusted fixture config may override ports/displays to avoid current formal instance during NAS isolated acceptance. Propagate selected CDP endpoints through startNativeCollector (Task1 currently hardcodes defaults). Package browser paths remain runtime/sysroot/usr/bin/{Xvfb,x11vnc,xauth}, runtime/chromium/chrome, runtime/novnc. Private non-glibc libs under runtime/sysroot/usr/lib/x86_64-linux-gnu and lib path. Do not default --no-sandbox; prove namespace sandbox or clearly fail. Keep browser process readiness distinct from external platform login state; do not downgrade an imported profile in place when native Chromium version is older.

### Task 3: 真实账本迁移与重新安装恢复

**Files:** Modify `server/fnos-native/configure.mjs`, `tests/web-fnos-native.test.mjs`, root-owned setup hooks under `deploy/fnos/wuchengerp/cmd`; add focused `tests/web-fnos-native-migration.test.mjs` as useful. Do not modify browser transport or implement build scripts in this task.

**Interfaces:** `configureNative` interface remains unchanged. Migration preserves copied business databases, lock/password/audit/outbox/snapshots without generic SQL path UPDATEs. Configuration still rebases program/data directories. Valid relative original-file references resolve from unchanged directory layout. Unsupported genuine legacy absolute references must be clearly refused before atomic publication, or use explicit verified read-boundary mapping; never alter triggers to bypass protection. Root setup recovery is a separate bounded hook, not runtime repair.

- [x] Write a regression using real module openStore with dataVersion capture enabled and actual imports protected by scoped/whole-month locks; show old UPDATE migration fails. Replace dummy file fixture assumptions with meaningful real references. Verify source and migrated DB file hashes plus outbox/snapshot hashes and original-file bytes unchanged.
- [x] Remove remapReferences business writes. Read-only inspect actual documented reference columns, verify relative originals/evidence exist within copied data roots, and refuse unsupported absolute references before publication (implement precise read mapping only if actual required legacy data is found). Run `node --test tests/web-fnos-native-migration.test.mjs tests/web-fnos-native.test.mjs` plus narrow actual-module lock tests only as needed.
- [x] Replace fresh/migrate crash-stale mkdir lock with an OS-released SQLite lock in private stable sibling location. Preserve unowned staged copies, test killed initializer retry without deleting data.
- [x] Complete retained-data reinstall: root-owned installation/upgrade recovery may fix ownership only within validated physical retained `@wuchengerp-data/erp` and its backups after service stop, using existing no-follow/no-cross-filesystem tools. Never recursive chown target or user-selected directories, never on normal status/start. Test old/new synthetic UIDs and retained lock/password/original recovery, syntax/diff checks; commit.
- [x] Fresh installs must map the actual fnOS relay `Host: localhost` to the explicitly configured primary HTTPS fnOS origin, including a no-Origin first GET. Ensure the primary origin is allowed; do not trust forwarded headers or arbitrary Host values. Existing migration host aliases remain unchanged. Wizard labels identify the primary fnOS relay URL separately from additional allowed origins.

### Task 4: 官方完整 FPK 构建与 CI

**Files:** Add `deploy/fnos/build-native.sh`, runtime dependency preparation helpers using standard Debian tooling, native CI workflow, third-party manifest and install instructions; update manifest version to 0.15.0 and package root version, existing `build.ps1` mode handling; add focused artifact tests.

**Interfaces:** CI Debian bookworm x86 produces FPK `wuchengerp` version0.15.0 with `app/runtime/node/bin/node`, `app/erp` accepted release, browser/runtime dependencies in `app/runtime`, noVNC assets. Runs official fnpack1.2.3. Bundled Node24 pinned version and official SHA; Linux production dependencies installed via existing prepareRelease. Bundle ELF dependencies using existing lddtree/dpkg tooling and licenses/source references; publish build artifact +SHA256, no business data. Fresh install mode and `--config` passed by lifecycle as defined Task1.

- [ ] Write artifact tests: no user data, required production payload, correct architecture/version, shell LF/modes, official CLI use, private Node SQLite smoke, native app lifecycle isolated fresh restart/stop.
- [ ] Implement build and workflow with native Linux integration checks plus existing module tests. Prepare optional UVCS on current NAS from official installer if redistributing it is not licensed; package must not include credentials, current instance cannot silently disable queue.
- [ ] Runtime build specifics: retain host glibc2.36 (exclude glibc family and loader from private LD_LIBRARY_PATH); private non-glibc closure and NSS dlopen components. Standard Debian Xvfb hardcodes xkbcomp path: build Debian source Xvfb with `--with-xkb-bin-directory=/var/apps/wuchengerp/target/runtime/sysroot/usr/bin`; keep XKB data private and pass `-xkbdir`. Use lddtree standard `--copy-to-tree`, verify actual installed flags. Task1 reserves root-owned `cmd/provision_uvcs`, selected only by `wizard_uvcs_install=1`; never root-execute replaceable target runtime scripts. Fetch official UVCS11.0.16.10616-1 amd64 deb SHA256 `b90be9da5670b8aa129b7ed3c3527192e7620c5f1f6d3f97e33f0e2733502ef6` (81720976bytes), verify before system package install; no auto dist-upgrade or unrelated package removal.
- [ ] Pin noVNC **v1.6.0**: the authenticated vnc.html CSP allows its exact upstream bootstrap hash `sha256-/9PPJp0RDtPobChVxkPiMU+aOqJaic/KxxORSdYVFHE=`. Preserve upstream HTML bytes and notices. For Xvfb Meson builds use `-Dxkb_bin_dir=/var/apps/wuchengerp/target/runtime/sysroot/usr/bin` (the preceding autoconf option is equivalent intent, not a Meson flag). Signed Debian indexes must be verified by apt. Preserve Chromium resources and NSS dlopen dependencies, X11 misc fonts and Noto CJK; never enable `--no-sandbox` as a fallback.
- [ ] Run Linux retained-data UID integration from Task 3 with trusted system `/usr/bin/python3`; root recovery uses this interpreter and refuses absence. Verify its availability on NAS before installation, and document/install the official system prerequisite if needed rather than executing package-writable Node as root.
- [ ] Final Node pin is **24.22.2**, matching the current formal runtime and including intervening security fixes, from `https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz`, official SHA256 `48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75`. Earlier research input 24.18.0 is superseded. Verify the payload in a fresh Debian 12 slim runtime without installed X11/GTK/NSS/fonts/XKB build dependencies; private payload must supply those. Check controlled process library mappings where readable against payload paths and an explicit host glibc/loader allowance, and report sandbox-denied evidence accurately.
- [ ] Produce an optional test-only official FPK `wuchengerpdiag`, reusing the exact runtime/release and parameterized smoke script with a separately compiled Xvfb helper prefix `/var/apps/wuchengerpdiag/target/runtime/sysroot/usr/bin`. Its trusted install hook only prepares its own private physical `@wuchengerpdiag-data` and runs the bounded smoke as its dedicated package user, never root. Use explicit synthetic production data, fnOS disabled, independent loopback TCP/module/CDP/VNC/display ranges, no UVCS, no formal paths or Tailscale changes. Reuse actual nativeLifecycle/supervisor and official noVNC for automated RFB keyboard/mouse/Chinese/screenshot/download checks; all temporary endpoints remain loopback and finally stop. No new remote auth adapter or PID framework. Export JSON/screenshot evidence; desktop report UI only if supported without a new service. A one-shot diagnostic package may remain stopped after successful checks; it is not the main application or production identity acceptance. Verify diagnostic stop/cancellation cleanup and hard timeout rather than leaving unmanaged test children.
- [ ] Push branch, execute GitHub workflow, inspect every check and artifact manifest, download FPK; commit corrections and independent task review. The one broad whole-branch code review follows Task 5, before operational Task 6 installs or migrates on NAS.

### Task 5: 旧 Windows 相对原件路径兼容与原生 UVCS 验证

**Files:** A focused shared stored-file resolver if needed, `server/fnos-native/configure.mjs`, owning sales original/freight/evidence/backup/agent file-read boundaries and overview `sourceOriginal`, with focused migration and original-download tests. Reuse existing safe path/symlink checks and release asset mechanisms. Do not modify unrelated UI or rewrite any business SQL, snapshots or outbox.

**Interfaces:** Real NAS read-only census found legacy stored values such as `originals\\filename` with physical `originals/filename` files. Normalize separators only at the verified relative-file read boundary. Reject POSIX absolute paths, Windows drive/UNC/drive-relative paths, traversal, symlink escape and missing originals. Keep native POSIX references and Windows execution working. Migration preflight and all directly affected readers must resolve the same file without modifying stored values.

- [ ] Write real-store migration regression with Windows-style relative imports, freight attachments and platform-reference evidence; verify DB/lock/password/outbox/snapshot/source hashes unchanged and actual original bytes readable after migration. Include traversal/absolute/symlink refusal.
- [ ] Apply one precise resolver at affected migration validation, sales HTTP and agent original/evidence/freight readers, sales backup/verification and overview source-original boundary. Inspect importer and handoff verification reads of the same stored columns, cover directly affected paths. Preserve folder allowlists and immutable snapshots. Do not create duplicate backslash filenames, symlinks or fake SQL authorization.
- [ ] Run focused module/migration/security tests; independent task review, then refresh both FPK artifacts through the Task 4 workflow and verify checksums before NAS installation. A second full suite is required only for new cross-module changes or unresolved failures.
- [ ] Add a fixed, opt-in native UVCS read-only verification command reachable through the official fnOS configuration wizard (default off). `config_init` stops the app; the verify-only callback branch runs as package user before prepare/provision/configure and never changes config. Read existing queue read-only, check configured repository via official cm, verify every submitted event maps uniquely to its recorded changeset. Never instantiate worker, call side-effecting adapter.findEvent/runCm, create workspace, retry/commit, clean staging, or disable UVCS. Refuse unconfirmed running service/command leases; bound child and total execution. Only write a new private sanitized diagnostic report; queue/outbox/snapshots/HOME/config stay unchanged. Exact inputs and security tests are specified in the Task5 interface notes. This supplies actual host/package-user acceptance without SSH credentials or terminal UI automation; Docker-helper probes do not count as native-host proof.
- [ ] Complete UVCS registration migration before first native start: exact Linux11.0.16.10616 isolated proof shows official `cm showselector <copiedWorkspace>` registers existing metadata at its new physical path while keeping original wkid/name and all workspace bytes, with only copied HOME registration changing. Bind the trusted source wkid/name/RepSpec and metadata fingerprint into the stopped-source migration manifest. After atomic publication to the FINAL physical workspace (never stage), prepare registration as package user with bounded official commands, require unique matching original identity and unchanged workspace bytes. Persist pending/verified preparation state so ordinary lifecycle or direct supervisor start cannot bypass a failed registration. Failure preserves the complete published ledger for existing-mode retry; never delete/recreate workspace, hand-edit XML, create old root aliases, disable UVCS or use source directory writes. Preparation explicitly permits only copied HOME registration changes; the separate read-only verifier refuses unprepared/unregistered state and detects unexpected client-state changes. Add failure/timeout/GUID mismatch, wrong ordering, restart bypass, repeat preparation and existing-retry tests. Online repository/history proof remains mandatory before formal acceptance.

### Task 6: 实机备份、隔离验收与切换

**Files:** Private evidence under `C:/Users/90760/.codex-artifacts/erp-fnos-native-20261108`; final generic docs under `docs` only, never commit credentials.

**Interfaces:** Consumes verified FPK and prior physical formal config. Migration source is stopped complete backup, verified before configureNative migrate. Native service must use same Tailscale TCP endpoint and existing fnOS app prefix. Old containers remain stopped rollback copies.

- [ ] Read-only inspect NAS actual OS/CPU/libc/runtime/package paths and current ledger summary/UVCS/browser profiles.
- [ ] Install isolated diagnostic/candidate app or invoke native acceptance with synthetic data; test runtime libraries and true noVNC handshake/interaction, fresh lifecycle and retained-data recovery.
- [ ] Stop writes + existing ERP/collector/browser containers; archive all config/data/state/data-version/UVCS HOME/browser profiles to unique private backup, restore check integrity and digests.
- [ ] Upgrade main FPK, copy from verified source, configure old identity and Tailscale endpoints, run native as package user; keep old Docker restart policies disabled. If any mandatory proof fails, restore old program/config against unchanged current ledger and report remaining blocker.
- [ ] Verify both entries, three matching digests, lock/password/admin state, UVCS queue/CLI, browser view and loopback-only CDP, app stop/start. Verify ERP containers all stopped. Merge/push with checks after review, leave final app open and report exact installed artifact and backup.
