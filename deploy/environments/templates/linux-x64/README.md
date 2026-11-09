# Linux x64 environment

Debian 12 x86_64 (glibc 2.36+) package. The archive contains the accepted ERP release and its matching private Node, Chromium, Xvfb, and noVNC runtime. No system Node, Docker, or browser installation is used.

Install the immutable package under `/opt/wuchengerp` as a dedicated unprivileged account. Create a private, user-owned parent for DATA and runtime state so the configurator can atomically create its new child directories:

```sh
sudo install -d -o wuchengerp -g wuchengerp -m 0700 /var/lib/wuchengerp-env
```

Keep persistent books and profiles under `/var/lib/wuchengerp-env/data`; the default runtime state directory is `/var/lib/wuchengerp-env/data-runtime` and is created private (0700). Do not run configure or the service as root. Configure a real Tailscale HTTPS origin and a fresh data path:

```sh
/opt/wuchengerp/erp.sh configure \
  --release /opt/wuchengerp/erp --data /var/lib/wuchengerp-env/data --origin https://host.tailnet-123.ts.net
```

The configure command initializes new books only. Existing data requires the explicit `--mode existing` path and cannot be converted between Tailscale and fnOS authentication. Configure the machine's Tailscale Serve separately to proxy the configured HTTPS origin to the local ERP gateway. Tailscale itself is not installed or reconfigured by this package.

For systemd, create a dedicated `wuchengerp` user, install the supplied unit, and adjust its HOME, config path, and `ReadWritePaths` if you chose different directories. Review the unit before enabling it. The application files should be root owned and read-only to the service user; only persistent data and runtime directories should be writable. The package does not install or enable a production service automatically.
