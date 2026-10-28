package sidecar

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

type BackendStatus struct {
	State    string   `json:"state"`
	LoginURL string   `json:"loginURL,omitempty"`
	NodeIPs  []string `json:"nodeIPs,omitempty"`
}

type Backend interface {
	Status(context.Context) (BackendStatus, error)
	Login(context.Context) error
	Logout(context.Context) error
	Dial(context.Context, string, string) (net.Conn, error)
	Close() error
}

type Factory func(context.Context, Config) (Backend, error)

type Status struct {
	ProtocolVersion int `json:"protocolVersion"`
	BackendStatus
	Origin        string `json:"origin"`
	ProxyURL      string `json:"proxyURL"`
	ProxyUsername string `json:"proxyUsername"`
	ProxyRealm    string `json:"proxyRealm"`
	PrototypeOnly bool   `json:"prototypeOnly"`
}

type Manager struct {
	mu         sync.Mutex
	operations sync.Mutex
	config     Config
	authority  string
	factory    Factory
	backend    Backend
	state      string
	generation uint64
	listener   net.Listener
	server     *http.Server
	realm      string
	active     map[net.Conn]bool
	permits    chan struct{}
	lock       io.Closer
	closed     bool
	closeOnce  sync.Once
	closeError error
}

// New starts only the authenticated loopback proxy. It never creates or starts
// a tsnet.Server. The factory is called only by an authenticated start/login.
func New(config Config, factory Factory, stateLock io.Closer) (*Manager, error) {
	authority, err := config.validate()
	if err != nil {
		return nil, failure("INVALID_CONFIG", err.Error())
	}
	if factory == nil || stateLock == nil {
		return nil, failure("INVALID_CONFIG", "backend factory and exclusive state lock are required")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, failure("LISTEN_FAILED", "could not open private loopback proxy")
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		listener.Close()
		return nil, err
	}
	m := &Manager{config: config, authority: authority, factory: factory, state: "stopped", listener: listener, realm: "LingtuTailnet/" + hex.EncodeToString(nonce[:]), active: map[net.Conn]bool{}, permits: make(chan struct{}, 16), lock: stateLock}
	m.server = &http.Server{Handler: http.HandlerFunc(m.proxy), ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 8192, ErrorLog: log.New(io.Discard, "", 0)}
	go func() { _ = m.server.Serve(listener) }()
	return m, nil
}

func (m *Manager) status(ctx context.Context) (Status, error) {
	m.mu.Lock()
	backend, state := m.backend, m.state
	m.mu.Unlock()
	s := Status{ProtocolVersion: 1, BackendStatus: BackendStatus{State: state}, Origin: m.config.Origin, ProxyURL: "http://" + m.listener.Addr().String(), ProxyUsername: "workbench", ProxyRealm: m.realm, PrototypeOnly: true}
	if backend != nil {
		var err error
		s.BackendStatus, err = backend.Status(ctx)
		if err != nil {
			return s, failure("STATUS_FAILED", "could not inspect the embedded private connection")
		}
	}
	return s, nil
}

func (m *Manager) start(ctx context.Context) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return failure("STOPPED", "sidecar is closed")
	}
	if m.backend != nil {
		m.mu.Unlock()
		return nil
	}
	m.state = "starting"
	m.mu.Unlock()
	backend, err := m.factory(ctx, m.config)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		m.state = "error"
		return err
	}
	if m.closed {
		backend.Close()
		return failure("STOPPED", "sidecar is closed")
	}
	m.backend = backend
	return nil
}

func (m *Manager) stop(ctx context.Context, logout, force bool) error {
	m.mu.Lock()
	backend := m.backend
	if !force && len(m.active) != 0 {
		m.mu.Unlock()
		return failure("TAILNET_BUSY", "active connections may belong to another workbench task; close them before stopping or signing out")
	}
	if logout && backend == nil {
		if m.state == "logged-out" {
			m.mu.Unlock()
			return nil
		}
		m.mu.Unlock()
		return failure("LOGOUT_REQUIRES_START", "resume the private connection before official logout; saved identity has not been removed")
	}
	m.backend = nil
	m.generation++
	m.state = "stopped"
	for conn := range m.active {
		_ = conn.Close()
	}
	m.mu.Unlock()
	if backend == nil {
		return nil
	}
	var err error
	if logout {
		err = backend.Logout(ctx)
		if err == nil {
			m.mu.Lock()
			m.state = "logged-out"
			m.mu.Unlock()
		}
	}
	err = errors.Join(err, backend.Close())
	if err != nil {
		return failure("STOP_FAILED", "private connection stopped; logout or shutdown could not be fully confirmed")
	}
	return nil
}

func (m *Manager) Operate(ctx context.Context, op string) (Status, error) {
	m.operations.Lock()
	defer m.operations.Unlock()
	switch op {
	case "status":
	case "start", "login":
		if err := m.start(ctx); err != nil {
			return Status{}, err
		}
		if op == "login" {
			m.mu.Lock()
			backend := m.backend
			m.mu.Unlock()
			if err := backend.Login(ctx); err != nil {
				return Status{}, failure("LOGIN_FAILED", "could not request official interactive login")
			}
		}
	case "stop", "logout":
		if err := m.stop(ctx, op == "logout", false); err != nil {
			return Status{}, err
		}
	default:
		return Status{}, failure("UNKNOWN_OPERATION", "unsupported operation")
	}
	return m.status(ctx)
}

func (m *Manager) Close() error {
	m.closeOnce.Do(func() {
		m.mu.Lock()
		m.closed = true
		m.mu.Unlock()
		m.operations.Lock()
		defer m.operations.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		m.closeError = errors.Join(m.stop(ctx, false, true), m.server.Close(), m.lock.Close())
	})
	return m.closeError
}
