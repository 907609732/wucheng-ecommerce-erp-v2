// Package tsbackend wraps the official userspace tsnet node. Nothing in this
// package initializes networking until New is explicitly called after init.
package tsbackend

import (
	"context"
	"errors"
	"net"
	"net/url"
	"os"
	"regexp"
	"sync"
	"time"

	"lingtu.local/workbench/tailnet/internal/securestate"
	"lingtu.local/workbench/tailnet/internal/sidecar"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

type Backend struct {
	server      *tsnet.Server
	client      *local.Client
	host        string
	authority   string
	watcher     *local.IPNBusWatcher
	cancel      context.CancelFunc
	mu          sync.Mutex
	loginURL    string
	watchFailed bool
	closed      bool
	closeOnce   sync.Once
	closeErr    error
}

// RejectBootstrapEnvironment prevents upstream environment fallbacks from
// silently using an auth key, OAuth secret, different control plane or profile.
func RejectBootstrapEnvironment() error {
	for _, key := range []string{"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE", "TS_CONTROL_URL", "TSNET_FORCE_LOGIN"} {
		if os.Getenv(key) != "" {
			return &sidecar.Error{Code: "BOOTSTRAP_ENV_PROHIBITED", Message: "inherited Tailscale bootstrap credentials or overrides are prohibited"}
		}
	}
	return nil
}

func New(ctx context.Context, config sidecar.Config) (sidecar.Backend, error) {
	if err := RejectBootstrapEnvironment(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store, err := securestate.New(config.StateDir)
	if err != nil {
		return nil, &sidecar.Error{Code: "STATE_UNAVAILABLE", Message: "private Windows node state could not be decrypted or opened"}
	}
	u, err := url.Parse(config.Origin)
	if err != nil {
		return nil, errors.New("invalid configured origin")
	}
	server := &tsnet.Server{Dir: config.StateDir, Hostname: config.Hostname, Store: store,
		ControlURL: "https://controlplane.tailscale.com", UserLogf: func(string, ...any) {}, Logf: func(string, ...any) {}}
	// Start, not Up: no Serve reset, automatic exit-node selection, inbound
	// listeners, routes, Funnel, tagged keys or local management web client.
	if err := server.Start(); err != nil {
		_ = server.Close()
		return nil, &sidecar.Error{Code: "START_FAILED", Message: "embedded private connection could not start"}
	}
	client, err := server.LocalClient()
	if err != nil {
		_ = server.Close()
		return nil, &sidecar.Error{Code: "STATUS_WATCH_FAILED", Message: "embedded control client unavailable"}
	}
	watchCtx, cancel := context.WithCancel(context.Background())
	type watchResult struct {
		watcher *local.IPNBusWatcher
		err     error
	}
	watchResultCh := make(chan watchResult, 1)
	go func() {
		watcher, err := client.WatchIPNBus(watchCtx, ipn.NotifyInitialState)
		watchResultCh <- watchResult{watcher, err}
	}()
	var watcher *local.IPNBusWatcher
	setupTimer := time.NewTimer(10 * time.Second)
	defer setupTimer.Stop()
	select {
	case result := <-watchResultCh:
		watcher, err = result.watcher, result.err
	case <-ctx.Done():
		err = ctx.Err()
	case <-setupTimer.C:
		err = errors.New("watcher setup timed out")
	}
	if err != nil {
		cancel()
		_ = server.Close()
		return nil, &sidecar.Error{Code: "STATUS_WATCH_FAILED", Message: "embedded status watcher unavailable"}
	}
	b := &Backend{server: server, client: client, host: u.Hostname(), authority: u.Host, watcher: watcher, cancel: cancel}
	go b.watch()
	return b, nil
}

var loginPath = regexp.MustCompile(`^/a/[a-zA-Z0-9_-]+$`)

func validLoginURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == "login.tailscale.com" && u.User == nil && u.Fragment == "" && u.RawQuery == "" && u.RawPath == "" && loginPath.MatchString(u.Path)
}

func (b *Backend) watch() {
	for {
		n, err := b.watcher.Next()
		b.mu.Lock()
		if err != nil {
			if !b.closed {
				b.watchFailed = true
			}
			b.mu.Unlock()
			return
		}
		if n.BrowseToURL != nil {
			if validLoginURL(*n.BrowseToURL) {
				b.loginURL = *n.BrowseToURL
			} else {
				b.loginURL = ""
			}
		}
		if n.State != nil && *n.State == ipn.Running {
			b.loginURL = ""
		}
		b.mu.Unlock()
	}
}

func (b *Backend) Status(ctx context.Context) (sidecar.BackendStatus, error) {
	b.mu.Lock()
	closed, watchFailed, loginURL := b.closed, b.watchFailed, b.loginURL
	b.mu.Unlock()
	if closed || watchFailed {
		return sidecar.BackendStatus{}, errors.New("embedded status unavailable")
	}
	s, err := b.client.Status(ctx)
	if err != nil {
		return sidecar.BackendStatus{}, errors.New("embedded status unavailable")
	}
	state := "starting"
	switch s.BackendState {
	case "Running":
		state = "running"
		loginURL = ""
	case "NeedsLogin":
		state = "needs-login"
	case "NeedsMachineAuth":
		state = "needs-approval"
	case "Stopped":
		state = "stopped"
	case "NoState", "Starting":
	default:
		state = "error"
	}
	result := sidecar.BackendStatus{State: state, LoginURL: loginURL}
	for _, ip := range s.TailscaleIPs {
		result.NodeIPs = append(result.NodeIPs, ip.String())
	}
	return result, nil
}

func (b *Backend) Login(ctx context.Context) error { return b.client.StartLoginInteractive(ctx) }
func (b *Backend) Logout(ctx context.Context) error {
	b.mu.Lock()
	b.loginURL = ""
	b.mu.Unlock()
	return b.client.Logout(ctx)
}
func (b *Backend) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	if network != "tcp" || addr != b.authority {
		return nil, errors.New("destination prohibited")
	}
	ipAddresses, err := resolve(ctx, b.client, b.host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ipAddresses {
		conn, err := b.server.Dial(ctx, "tcp", net.JoinHostPort(ip.String(), "8443"))
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			break
		}
	}
	return nil, errors.New("approved private destination unavailable")
}
func (b *Backend) Close() error {
	b.closeOnce.Do(func() {
		b.mu.Lock()
		b.closed = true
		b.loginURL = ""
		b.mu.Unlock()
		b.cancel()
		_ = b.watcher.Close()
		b.closeErr = b.server.Close()
	})
	return b.closeErr
}
