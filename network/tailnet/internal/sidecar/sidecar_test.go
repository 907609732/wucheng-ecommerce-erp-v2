package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testHost = "workbench.synthetic-tail.ts.net"

func testConfig(t *testing.T) Config {
	t.Helper()
	return Config{Origin: "https://" + testHost + ":8443", StateDir: filepath.Join(t.TempDir(), "node"), Hostname: "lingtu-synthetic", Nonce: strings.Repeat("a1", 32), ProxyPassword: strings.Repeat("b2", 32)}
}

type fakeLock struct {
	mu     sync.Mutex
	closes int
}

func (f *fakeLock) Close() error { f.mu.Lock(); defer f.mu.Unlock(); f.closes++; return nil }

type fakeBackend struct {
	mu                             sync.Mutex
	state                          string
	logins, logouts, closes, dials int
	destinations                   []string
	dial                           func(context.Context, string, string) (net.Conn, error)
	logoutError                    error
}

func (f *fakeBackend) Status(context.Context) (BackendStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return BackendStatus{State: f.state}, nil
}
func (f *fakeBackend) Login(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logins++
	return nil
}
func (f *fakeBackend) Logout(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logouts++
	return f.logoutError
}
func (f *fakeBackend) Close() error { f.mu.Lock(); defer f.mu.Unlock(); f.closes++; return nil }
func (f *fakeBackend) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	f.mu.Lock()
	f.dials++
	f.destinations = append(f.destinations, addr)
	fn := f.dial
	f.mu.Unlock()
	if fn == nil {
		return nil, errors.New("isolated no-dial")
	}
	return fn(ctx, network, addr)
}

func TestConfigRejectsAlternateDestinations(t *testing.T) {
	for _, origin := range []string{"http://" + testHost + ":8443", "https://" + testHost, "https://" + testHost + ":443", "https://100.80.1.2:8443", "https://example.com:8443", "https://user@" + testHost + ":8443", "https://" + testHost + ":8443/apps/", "https://" + testHost + ":8443?token=x", "https://" + testHost + ":8443#x", "https://WORKBENCH.synthetic-tail.ts.net:8443", "https://" + testHost + ".:8443", "https://a..ts.net:8443"} {
		t.Run(origin, func(t *testing.T) {
			c := testConfig(t)
			c.Origin = origin
			if _, err := c.validate(); err == nil {
				t.Fatal("unsafe origin accepted")
			}
		})
	}
	c := testConfig(t)
	c.Nonce = c.ProxyPassword
	if _, err := c.validate(); err == nil {
		t.Fatal("same credentials accepted")
	}
	c = testConfig(t)
	c.StateDir = "relative"
	if _, err := c.validate(); err == nil {
		t.Fatal("relative state accepted")
	}
	c = testConfig(t)
	c.ProxyPassword = "short"
	if _, err := c.validate(); err == nil {
		t.Fatal("short credential accepted")
	}
}

func TestLifecycleIsInertAndCoalescesStart(t *testing.T) {
	c := testConfig(t)
	calls := 0
	backend := &fakeBackend{state: "needs-login"}
	lock := &fakeLock{}
	m, err := New(c, func(context.Context, Config) (Backend, error) { calls++; return backend, nil }, lock)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	s, err := m.Operate(context.Background(), "status")
	if err != nil || s.State != "stopped" || calls != 0 {
		t.Fatal("init unexpectedly started backend")
	}
	for range 2 {
		if _, err = m.Operate(context.Background(), "start"); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatal("start duplicated backend")
	}
	if _, err = m.Operate(context.Background(), "login"); err != nil {
		t.Fatal(err)
	}
	if backend.logins != 1 || calls != 1 {
		t.Fatal("login did not reuse backend")
	}
	if _, err = m.Operate(context.Background(), "logout"); err != nil {
		t.Fatal(err)
	}
	if backend.logouts != 1 || backend.closes != 1 {
		t.Fatal("logout did not close backend")
	}
	if status, err := m.Operate(context.Background(), "logout"); err != nil || status.State != "logged-out" || backend.logouts != 1 {
		t.Fatal("confirmed logout retry was not idempotent")
	}
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
	if lock.closes != 1 {
		t.Fatal("state lock released more than once")
	}
}

func TestStoppedLogoutDoesNotPretendToForgetPersistedIdentity(t *testing.T) {
	c := testConfig(t)
	calls := 0
	backend := &fakeBackend{state: "running"}
	m, err := New(c, func(context.Context, Config) (Backend, error) { calls++; return backend, nil }, &fakeLock{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	for range 2 {
		_, err := m.Operate(context.Background(), "logout")
		var typed *Error
		if !errors.As(err, &typed) || typed.Code != "LOGOUT_REQUIRES_START" {
			t.Fatal("stopped logout falsely claimed saved identity removal")
		}
		status, _ := m.Operate(context.Background(), "status")
		if status.State != "stopped" {
			t.Fatal("failed logout changed state")
		}
		if calls == 0 {
			_, _ = m.Operate(context.Background(), "start")
			_, _ = m.Operate(context.Background(), "stop")
		}
	}
	if calls != 1 || backend.logouts != 0 {
		t.Fatal("logout silently resumed or erased identity")
	}
}

func TestFailedOfficialLogoutDoesNotClaimPersistedIdentityRemoval(t *testing.T) {
	c := testConfig(t)
	backend := &fakeBackend{state: "running", logoutError: errors.New("synthetic control offline")}
	m, err := New(c, func(context.Context, Config) (Backend, error) { return backend, nil }, &fakeLock{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	_, _ = m.Operate(context.Background(), "start")
	if _, err = m.Operate(context.Background(), "logout"); err == nil {
		t.Fatal("failed official logout accepted")
	}
	status, _ := m.Operate(context.Background(), "status")
	if status.State != "stopped" || backend.closes != 1 {
		t.Fatal("failed logout falsely claimed identity removal or left backend running")
	}
}

func TestProtocolAuthenticationAndEOF(t *testing.T) {
	c := testConfig(t)
	backend := &fakeBackend{state: "running"}
	lock := &fakeLock{}
	factories := 0
	requests := []any{
		map[string]any{"v": 1, "id": "before", "op": "start"},
		Request{V: 1, ID: "init", Op: "init", Config: c},
		map[string]any{"v": 1, "id": "bad-nonce", "op": "start", "nonce": "wrong"},
		map[string]any{"v": 1, "id": "bad-field", "op": "start", "nonce": c.Nonce, "authKey": "forbidden"},
		map[string]any{"v": 1, "id": "change", "op": "start", "nonce": c.Nonce, "origin": c.Origin},
		map[string]any{"v": 1, "id": "start", "op": "start", "nonce": c.Nonce},
		map[string]any{"v": 1, "id": "shutdown", "op": "shutdown", "nonce": c.Nonce},
	}
	var input, output bytes.Buffer
	for _, r := range requests {
		if err := json.NewEncoder(&input).Encode(r); err != nil {
			t.Fatal(err)
		}
	}
	err := Run(context.Background(), &input, &output, func(c Config) (*Manager, error) {
		return New(c, func(context.Context, Config) (Backend, error) { factories++; return backend, nil }, lock)
	})
	if err != nil {
		t.Fatal(err)
	}
	var responses []Response
	decoder := json.NewDecoder(&output)
	for decoder.More() {
		var r Response
		if err := decoder.Decode(&r); err != nil {
			t.Fatal(err)
		}
		responses = append(responses, r)
	}
	if len(responses) != 7 || responses[0].Error.Code != "NOT_INITIALIZED" || responses[2].Error.Code != "UNAUTHORIZED" || responses[3].Error.Code != "INVALID_REQUEST" || responses[4].Error.Code != "INVALID_REQUEST" {
		t.Fatal("unsafe protocol authorization")
	}
	if responses[1].Result.State != "stopped" || responses[6].Result.State != "stopped" || factories != 1 || backend.closes != 1 || lock.closes != 1 {
		t.Fatal("inert init/shutdown lifecycle failed")
	}
	serialized, _ := json.Marshal(responses)
	if bytes.Contains(serialized, []byte(c.Nonce)) || bytes.Contains(serialized, []byte(c.ProxyPassword)) {
		t.Fatal("process credential in response")
	}
	// A parent crash/EOF while running also closes the backend and releases lock.
	input.Reset()
	output.Reset()
	lock = &fakeLock{}
	backend = &fakeBackend{state: "running"}
	_ = json.NewEncoder(&input).Encode(Request{V: 1, ID: "init", Op: "init", Config: c})
	_ = json.NewEncoder(&input).Encode(map[string]any{"v": 1, "id": "start", "op": "start", "nonce": c.Nonce})
	if err = Run(context.Background(), &input, &output, func(c Config) (*Manager, error) {
		return New(c, func(context.Context, Config) (Backend, error) { return backend, nil }, lock)
	}); err != nil {
		t.Fatal(err)
	}
	if backend.closes != 1 || lock.closes != 1 {
		t.Fatal("EOF leaked backend ownership")
	}
}

func proxyRequest(t *testing.T, m *Manager, c Config, method, target, auth string) (*http.Response, net.Conn) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", m.listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if auth == "valid" {
		auth = "Basic " + base64.StdEncoding.EncodeToString([]byte("workbench:"+c.ProxyPassword))
	}
	hostHeader := target
	if strings.HasPrefix(target, "http://") {
		parsed, _ := url.Parse(target)
		hostHeader = parsed.Host
	}
	_, err = io.WriteString(conn, method+" "+target+" HTTP/1.1\r\nHost: "+hostHeader+"\r\nProxy-Authorization: "+auth+"\r\n\r\n")
	if err != nil {
		conn.Close()
		t.Fatal(err)
	}
	r, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: method})
	if err != nil {
		conn.Close()
		t.Fatal(err)
	}
	return r, conn
}

func TestProxyRequiresAuthExactTargetAndRunningState(t *testing.T) {
	c := testConfig(t)
	backend := &fakeBackend{state: "needs-login"}
	m, err := New(c, func(context.Context, Config) (Backend, error) { return backend, nil }, &fakeLock{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	for _, auth := range []string{"", "Basic invalid"} {
		r, conn := proxyRequest(t, m, c, "CONNECT", testHost+":8443", auth)
		if r.StatusCode != 407 || !strings.Contains(r.Header.Get("Proxy-Authenticate"), m.realm) {
			t.Fatal("missing mandatory407")
		}
		r.Body.Close()
		conn.Close()
	}
	for _, target := range []string{"example.com:8443", "100.80.1.2:8443", testHost + ":443", "local-tailscaled.sock:8443", testHost + ".:8443"} {
		r, conn := proxyRequest(t, m, c, "CONNECT", target, "valid")
		if r.StatusCode != 403 {
			t.Fatal("alternate destination allowed")
		}
		r.Body.Close()
		conn.Close()
	}
	r, conn := proxyRequest(t, m, c, "GET", "http://"+testHost+":8443/", "valid")
	if r.StatusCode != 403 {
		t.Fatal("ordinary HTTP allowed")
	}
	r.Body.Close()
	conn.Close()
	r, conn = proxyRequest(t, m, c, "CONNECT", testHost+":8443", "valid")
	if r.StatusCode != 503 {
		t.Fatal("dial before start")
	}
	r.Body.Close()
	conn.Close()
	_, _ = m.Operate(context.Background(), "start")
	r, conn = proxyRequest(t, m, c, "CONNECT", testHost+":8443", "valid")
	if r.StatusCode != 503 || backend.dials != 0 {
		t.Fatal("dial before ready")
	}
	r.Body.Close()
	conn.Close()
}

func syntheticCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: testHost}, DNSNames: []string{testHost}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	pk, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pk}))
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

func TestAuthenticatedTunnelPreservesTLSAndForcedCloseCleansUp(t *testing.T) {
	c := testConfig(t)
	received := make(chan *http.Request, 2)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Clone(context.Background())
		_, _ = io.WriteString(w, "isolated TLS response")
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{syntheticCertificate(t)}}
	server.StartTLS()
	defer server.Close()
	backend := &fakeBackend{state: "running", dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}}
	m, err := New(c, func(context.Context, Config) (Backend, error) { return backend, nil }, &fakeLock{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	_, _ = m.Operate(context.Background(), "start")
	proxyURL, _ := url.Parse("http://" + m.listener.Addr().String())
	proxyURL.User = url.UserPassword("workbench", c.ProxyPassword)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: pool}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	response, err := client.Get(c.Origin + "/fixture")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "isolated TLS response" {
		t.Fatal("TLS content changed")
	}
	request := <-received
	if request.TLS == nil || request.TLS.ServerName != testHost || request.Header.Get("Proxy-Authorization") != "" {
		t.Fatal("TLS SNI or credential boundary failed")
	}
	if len(backend.destinations) != 1 || backend.destinations[0] != testHost+":8443" {
		t.Fatal("wrong backend target")
	}
	// Normal certificate validation remains mandatory through this proxy.
	badTransport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool()}}
	defer badTransport.CloseIdleConnections()
	if badResponse, err := (&http.Client{Transport: badTransport, Timeout: 5 * time.Second}).Get(c.Origin); err == nil {
		badResponse.Body.Close()
		t.Fatal("untrusted TLS certificate accepted")
	}
	// Explicit stop is conservative; EOF/crash cleanup must still close tunnels.
	r, conn := proxyRequest(t, m, c, "CONNECT", testHost+":8443", "valid")
	defer conn.Close()
	if r.StatusCode != 200 {
		t.Fatal("CONNECT did not open")
	}
	if _, err = m.Operate(context.Background(), "stop"); err == nil {
		t.Fatal("active tunnel was stopped without a busy result")
	}
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
	var b [1]byte
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = conn.Read(b[:]); err == nil {
		t.Fatal("forced EOF/crash cleanup left tunnel open")
	}
}

func TestExplicitLifecycleRefusesActiveTLSTunnel(t *testing.T) {
	for _, op := range []string{"stop", "logout", "shutdown"} {
		t.Run(op, func(t *testing.T) {
			c := testConfig(t)
			addresses := make(chan string, 2)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				addresses <- r.RemoteAddr
				_, _ = io.WriteString(w, "still serving")
			}))
			server.Config.ErrorLog = log.New(io.Discard, "", 0)
			server.TLS = &tls.Config{Certificates: []tls.Certificate{syntheticCertificate(t)}}
			server.StartTLS()
			defer server.Close()
			backend := &fakeBackend{state: "running", dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
			}}
			m, err := New(c, func(context.Context, Config) (Backend, error) { return backend, nil }, &fakeLock{})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			_, _ = m.Operate(context.Background(), "start")
			proxyURL, _ := url.Parse("http://" + m.listener.Addr().String())
			proxyURL.User = url.UserPassword("workbench", c.ProxyPassword)
			pool := x509.NewCertPool()
			pool.AddCert(server.Certificate())
			transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: pool}}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
			get := func() {
				t.Helper()
				response, err := client.Get(c.Origin + "/active-task")
				if err != nil {
					t.Fatal(err)
				}
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				if string(body) != "still serving" {
					t.Fatal("existing task content changed")
				}
			}
			get()
			originalAddress := <-addresses
			var invoke func() (string, error)
			var done chan error
			if op == "shutdown" {
				inputReader, inputWriter := io.Pipe()
				outputReader, outputWriter := io.Pipe()
				done = make(chan error, 1)
				go func() {
					err := Run(context.Background(), inputReader, outputWriter, func(Config) (*Manager, error) { return m, nil })
					_ = outputWriter.CloseWithError(err)
					done <- err
				}()
				defer inputWriter.Close()
				defer inputReader.Close()
				defer outputReader.Close()
				encoder, decoder := json.NewEncoder(inputWriter), json.NewDecoder(outputReader)
				rpc := func(op string, init bool) Response {
					t.Helper()
					request := Request{V: 1, ID: op, Op: op, Config: Config{Nonce: c.Nonce}}
					if init {
						request.Config = c
					}
					if err := encoder.Encode(request); err != nil {
						t.Fatal(err)
					}
					var response Response
					if err := decoder.Decode(&response); err != nil {
						t.Fatal("control loop closed after failed shutdown:", err)
					}
					return response
				}
				if !rpc("init", true).OK {
					t.Fatal("protocol init failed")
				}
				invoke = func() (string, error) {
					response := rpc("shutdown", false)
					if !response.OK {
						return "", response.Error
					}
					return response.Result.State, nil
				}
				_, err = invoke()
				var typed *Error
				if !errors.As(err, &typed) || typed.Code != "TAILNET_BUSY" {
					t.Fatal("active shutdown was not refused")
				}
				if status := rpc("status", false); !status.OK || status.Result.State != "running" {
					t.Fatal("failed shutdown broke the control loop or backend")
				}
			} else {
				invoke = func() (string, error) { status, err := m.Operate(context.Background(), op); return status.State, err }
				_, err = invoke()
				var typed *Error
				if !errors.As(err, &typed) || typed.Code != "TAILNET_BUSY" {
					t.Fatal("active lifecycle operation was not refused")
				}
			}
			get()
			if current := <-addresses; current != originalAddress {
				t.Fatal("busy result closed the original live TLS connection")
			}
			backend.mu.Lock()
			closes, logouts := backend.closes, backend.logouts
			backend.mu.Unlock()
			if closes != 0 || logouts != 0 {
				t.Fatal("busy result changed backend identity or lifetime")
			}
			transport.CloseIdleConnections()
			deadline := time.Now().Add(2 * time.Second)
			for {
				m.mu.Lock()
				active := len(m.active)
				m.mu.Unlock()
				if active == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("client TLS connection did not close")
				}
				time.Sleep(5 * time.Millisecond)
			}
			state, err := invoke()
			if err != nil {
				t.Fatal("quiet lifecycle operation failed:", err)
			}
			expected := "stopped"
			if op == "logout" {
				expected = "logged-out"
			}
			if state != expected {
				t.Fatal("quiet lifecycle operation returned incorrect state")
			}
			if done != nil {
				if err := <-done; err != nil {
					t.Fatal(err)
				}
			} else if op == "stop" {
				response, conn := proxyRequest(t, m, c, "CONNECT", testHost+":8443", "valid")
				response.Body.Close()
				conn.Close()
				if response.StatusCode != 503 {
					t.Fatal("stopped backend still routed traffic")
				}
			}
		})
	}
}
