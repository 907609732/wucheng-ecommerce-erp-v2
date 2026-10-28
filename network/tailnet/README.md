# Internal Tailnet connection prototype

Windows x64 only. This component uses the official `tailscale.com/tsnet` userspace
node. It is connected to the launcher's **0.10.0 candidate client mode**; real
Tailnet login, new-device grants and dual-PC acceptance are still separate.
There is no shared auth key, custom OAuth implementation, public tunnel, subnet
router, exit node selection, inbound Tailnet listener or remote LocalAPI.

## Environment and build

The pinned official SDK is Tailscale `v1.104.2`, requiring Go `1.27.3` or newer.
Use the system Go installation and `GOTOOLCHAIN=local`; never silently downgrade
the SDK or bootstrap a private toolchain. The module dependency checksums live in
`go.sum` after the prerequisite system upgrade and `go mod tidy` complete.

```
go test ./...
go vet ./...
go build -trimpath -o ../../dist/tailnet-prototype/lingtu-tailnet.exe ./cmd/lingtu-tailnet
```

Tests use fake collection backends, loopback TLS fixtures and synthetic DPAPI
state. They must not start or register a real `tsnet.Server`. Running the binary
with `--version` is offline; sending authenticated `start`/`login` is a separate
real network action. Inert automated tests never perform it; the application
opens the official authorization page only after an explicit user login action.

## Private stdio protocol, version 1

The owner process starts this executable without credential arguments and keeps
its stdin/stdout pipes private. stdout contains JSONL responses only. Every
request has `v:1`, an application-chosen string `id` (maximum 128 bytes) and `op`.
Maximum request line: 64 KiB. There are no unsolicited events; poll `status`.

The first operation is `init`, with these additional fields:

| Field | Contract |
| --- | --- |
| `nonce` | 32 random bytes encoded as 64 hex characters; private control credential |
| `proxyPassword` | Different 32 random bytes in hex; never sent to renderer |
| `origin` | One canonical lowercase `https://host.tailNN.ts.net:8443` origin |
| `stateDir` | Absolute private directory owned by this Windows user |
| `hostname` | Stable lowercase single DNS label for this new embedded node |

`init` does not create a tsnet node or start any network connection. It secures
the private directory, takes a Windows exclusive file lock and binds only an
ephemeral `127.0.0.1` HTTP proxy. A second process using that directory receives
`STATE_IN_USE`; locks are never deleted or reclaimed based on PID assumptions.

Later requests contain `nonce` and one operation:

| Operation | Behavior |
| --- | --- |
| `status` | Read current state; never starts network |
| `start` | Explicitly start/resume one encrypted embedded node |
| `login` | Start if needed and request official interactive login; URL arrives asynchronously |
| `stop` | Close an idle backend; retain encrypted identity, proxy and exclusive lock |
| `logout` | Official logout of an idle backend; a stopped backend returns `LOGOUT_REQUIRES_START` instead of pretending to erase persisted identity |
| `shutdown` | Stop an idle backend and close proxy/lock; failed shutdown keeps the control loop alive |

Success: `{v:1,id,ok:true,result:{protocolVersion:1,state,origin,proxyURL,
proxyUsername:"workbench",proxyRealm,prototypeOnly:true,loginURL?,nodeIPs?}}`.
`loginURL` is returned only after the SDK emits `BrowseToURL`, and only for the
exact HTTPS `login.tailscale.com/a/...` origin. It is never logged. The owner must
open it in the user's browser only for an explicit login action. States include
`stopped`, `starting`, `needs-login`, `needs-approval`, `running`, `logged-out`,
and `error`. Errors: `{v:1,id,ok:false,error:{code,message}}`, with sanitized
messages. No nonce, proxy password, node keys or backend error bodies appear in
responses. Configuration cannot change after init.

## Proxy and persistence boundary

- Every proxy request requires Basic authentication using `workbench` and the
  process-local `proxyPassword`; absent/invalid authentication returns 407.
- Only `CONNECT` to the exact configured authority on 8443 is accepted. Ordinary
  HTTP, IP substitutes, alternate ports, aliases and LocalAPI are rejected.
- MagicDNS uses the official SDK status peer map, then its `QueryDNS` endpoint.
  Only exact-name A/AAAA answers within Tailscale node IP ranges are accepted.
  Resolver failures do not fall back to the OS resolver, public egress or proxy.
- TLS bytes pass unchanged. Electron must keep standard SNI/certificate checks
  and its gateway session/CSRF/identity protections. There is no certificate
  override or TLS termination here.
- `ipn.StateStore` is wrapped in current-user Windows DPAPI, UI forbidden, with
  atomic writes and a restricted directory ACL. No machine-wide DPAPI mode or
  plaintext fallback. Custom encryption does not claim Tailscale's TPM posture.
- The child disables upstream log uploads/buffers, discards SDK log callbacks,
  and refuses inherited key/OAuth/custom-control bootstrap variables. This does
  not modify the Windows environment or the system Tailscale service.
- GUI, CLI and MCP must use one authenticated broker owning this process; the
  exclusive lock is a safety barrier, not a complete multi-client integration.
- Explicit stop/logout/shutdown return `TAILNET_BUSY` while any CONNECT tunnel
  remains open, including idle keep-alive connections that could belong to
  another application task. The caller must first close its own connections;
  other clients' connections are not interrupted. EOF/crash cleanup still
  forcibly closes tunnels and releases the lock.
- This creates a separate Tailnet device. Existing grants for an OS Tailscale
  device do not automatically authorize the new node. Enrollment, the real
  user's identity, explicit host-8443 grants and dual-computer acceptance are
  required before claiming connectivity.

The official ts-plug program was researched first. Its generic public fallback,
unauthenticated arbitrary-destination proxy and automatic exit-node behavior are
not appropriate here. Only the constrained CONNECT relay and MagicDNS pattern
were adapted; attribution is in `THIRD_PARTY_NOTICES.md`.

## Acceptance boundary

Pending real acceptance: official browser login, member/node approval, actual
Tailnet grants, encrypted identity resume after relaunch, two-PC HTTPS/API and
embedded-page operation, account changes and concurrent GUI/CLI/MCP broker use.
The prototype's synthetic tests do not validate live platform collection or
prove that FlClash/TUN is the cause of the previous connection failure.

Primary references: [tsnet SDK](https://pkg.go.dev/tailscale.com/tsnet),
[official ts-plug source](https://github.com/tailscale/ts-plug/blob/14756e741f145d4bcecd725cd022f780f122113d/cmd/ts-unplug-proxy/ts-unplug-proxy.go),
[LocalClient API](https://pkg.go.dev/tailscale.com/client/local),
[Windows DPAPI](https://pkg.go.dev/golang.org/x/sys/windows#CryptProtectData).
