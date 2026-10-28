// CONNECT relay adapted from tailscale/ts-plug, BSD-3-Clause.
// Upstream commit and license are recorded in THIRD_PARTY_NOTICES.md.
package sidecar

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

func (m *Manager) proxy(w http.ResponseWriter, r *http.Request) {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(ip).IsLoopback() {
		http.Error(w, "loopback only", http.StatusForbidden)
		return
	}
	credential := "Basic " + base64.StdEncoding.EncodeToString([]byte("workbench:"+m.config.ProxyPassword))
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(credential)) != 1 {
		w.Header().Set("Proxy-Authenticate", `Basic realm="`+m.realm+`"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	// No ordinary HTTP, LocalAPI, public egress, aliases, alternate IPs or ports.
	if r.Method != http.MethodConnect || r.RequestURI != m.authority || r.Host != m.authority || r.URL.User != nil || strings.ContainsAny(r.RequestURI, "/\\?#@") {
		http.Error(w, "destination not allowed", http.StatusForbidden)
		return
	}
	select {
	case m.permits <- struct{}{}:
		defer func() { <-m.permits }()
	default:
		http.Error(w, "proxy busy", http.StatusServiceUnavailable)
		return
	}
	m.mu.Lock()
	backend, generation := m.backend, m.generation
	m.mu.Unlock()
	if backend == nil {
		http.Error(w, "private connection is not running", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	status, err := backend.Status(ctx)
	if err != nil || status.State != "running" {
		http.Error(w, "private connection is not ready", http.StatusServiceUnavailable)
		return
	}
	upstream, err := backend.Dial(ctx, "tcp", m.authority)
	if err != nil {
		http.Error(w, "private connection failed", http.StatusBadGateway)
		return
	}
	defer upstream.Close()
	client, buffered, err := http.NewResponseController(w).Hijack()
	if err != nil {
		http.Error(w, "proxy unavailable", http.StatusInternalServerError)
		return
	}
	defer client.Close()
	m.mu.Lock()
	if generation != m.generation || backend != m.backend || m.closed {
		m.mu.Unlock()
		return
	}
	m.active[client], m.active[upstream] = true, true
	m.mu.Unlock()
	defer func() {
		// Do not clear the busy guard before both relay sockets are closed.
		_ = client.Close()
		_ = upstream.Close()
		m.mu.Lock()
		delete(m.active, client)
		delete(m.active, upstream)
		m.mu.Unlock()
	}()
	if _, err = io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	// Tunnel TLS bytes unchanged. The application remains responsible for normal
	// HTTPS certificate/SNI verification and its authenticated gateway session.
	var src io.Reader = buffered
	if buffered.Reader.Buffered() == 0 {
		src = client
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	go func() { _, _ = io.Copy(upstream, src); done <- struct{}{} }()
	<-done
}
