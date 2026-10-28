package sidecar

import (
	"encoding/hex"
	"errors"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

type Config struct {
	Origin        string `json:"origin"`
	StateDir      string `json:"stateDir"`
	Hostname      string `json:"hostname"`
	Nonce         string `json:"nonce"`
	ProxyPassword string `json:"proxyPassword"`
}

var hostname = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func (c *Config) validate() (string, error) {
	u, err := url.Parse(c.Origin)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") || u.Port() != "8443" {
		return "", errors.New("origin must be one canonical HTTPS Tailscale origin on port 8443")
	}
	host := u.Hostname()
	if len(host) > 253 || host != strings.ToLower(host) || !strings.HasSuffix(host, ".ts.net") || u.Host != host+":8443" {
		return "", errors.New("origin must use a canonical lowercase Tailscale FQDN")
	}
	for _, label := range strings.Split(host, ".") {
		if !hostname.MatchString(label) {
			return "", errors.New("invalid Tailscale hostname")
		}
	}
	if !filepath.IsAbs(c.StateDir) || !hostname.MatchString(c.Hostname) {
		return "", errors.New("an absolute private state directory and stable hostname are required")
	}
	for _, secret := range []string{c.Nonce, c.ProxyPassword} {
		b, err := hex.DecodeString(secret)
		if err != nil || len(b) != 32 {
			return "", errors.New("each process credential must contain 32 random bytes encoded as hex")
		}
	}
	if c.Nonce == c.ProxyPassword {
		return "", errors.New("control and proxy credentials must be different")
	}
	c.Origin = "https://" + u.Host
	return u.Host, nil
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func failure(code, message string) error { return &Error{code, message} }
