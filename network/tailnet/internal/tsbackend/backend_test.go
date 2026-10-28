package tsbackend

import (
	"context"
	"errors"
	"net/netip"
	"testing"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/key"
)

const host = "workbench.synthetic-tail.ts.net"

type fakeResolver struct {
	status  *ipnstate.Status
	query   func(string, string) ([]byte, error)
	queries int
}

func (f *fakeResolver) Status(context.Context) (*ipnstate.Status, error) { return f.status, nil }
func (f *fakeResolver) QueryDNS(_ context.Context, name, kind string) ([]byte, []*dnstype.Resolver, error) {
	f.queries++
	if f.query == nil {
		return nil, nil, errors.New("no fixture DNS")
	}
	b, err := f.query(name, kind)
	return b, nil, err
}

func dnsFixture(t *testing.T, name, kind, ip string) []byte {
	t.Helper()
	n, err := dnsmessage.NewName(name)
	if err != nil {
		t.Fatal(err)
	}
	typeValue := dnsmessage.TypeA
	addr := netip.MustParseAddr(ip)
	var body dnsmessage.ResourceBody
	if kind == "AAAA" {
		typeValue = dnsmessage.TypeAAAA
		body = &dnsmessage.AAAAResource{AAAA: addr.As16()}
	} else {
		body = &dnsmessage.AResource{A: addr.As4()}
	}
	message := dnsmessage.Message{Header: dnsmessage.Header{Response: true}, Questions: []dnsmessage.Question{{Name: n, Type: typeValue, Class: dnsmessage.ClassINET}}, Answers: []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: n, Type: typeValue, Class: dnsmessage.ClassINET, TTL: 10}, Body: body}}}
	b, err := message.Pack()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestMagicDNSUsesExactStatusPeerWithoutOSResolver(t *testing.T) {
	client := &fakeResolver{status: &ipnstate.Status{BackendState: "Running", Peer: map[key.NodePublic]*ipnstate.PeerStatus{{}: {DNSName: host + ".", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.90.1.2"), netip.MustParseAddr("fd7a:115c:a1e0::2")}}}}}
	ips, err := resolve(context.Background(), client, host)
	if err != nil || len(ips) != 2 || client.queries != 0 {
		t.Fatal("exact status resolution failed")
	}
	client.status.Peer[key.NodePublic{}].TailscaleIPs = []netip.Addr{netip.MustParseAddr("8.8.8.8")}
	if _, err = resolve(context.Background(), client, host); err == nil || client.queries != 0 {
		t.Fatal("public status IP accepted or fallback attempted")
	}
}

func TestQueryDNSOnlyUsesTailnetAnswersAndExactQuestion(t *testing.T) {
	client := &fakeResolver{status: &ipnstate.Status{BackendState: "Running"}}
	client.query = func(name, kind string) ([]byte, error) {
		if name != host+"." {
			t.Fatal("unexpected queried name")
		}
		ip := "100.90.1.2"
		if kind == "AAAA" {
			ip = "fd7a:115c:a1e0::2"
		}
		return dnsFixture(t, name, kind, ip), nil
	}
	ips, err := resolve(context.Background(), client, host)
	if err != nil || len(ips) != 2 || client.queries != 2 {
		t.Fatal("Tailnet DNS resolution failed")
	}
	for _, ip := range []string{"8.8.8.8", "127.0.0.1", "192.168.1.1", "100.100.100.100"} {
		t.Run(ip, func(t *testing.T) {
			client.query = func(name, kind string) ([]byte, error) {
				if kind == "AAAA" {
					return nil, errors.New("noAAAA")
				}
				return dnsFixture(t, name, kind, ip), nil
			}
			if _, err := resolve(context.Background(), client, host); err == nil {
				t.Fatal("unsafe DNS destination accepted")
			}
		})
	}
	client.query = func(name, kind string) ([]byte, error) {
		if kind == "AAAA" {
			return nil, errors.New("noAAAA")
		}
		return dnsFixture(t, "different.synthetic-tail.ts.net.", kind, "100.90.1.2"), nil
	}
	if _, err = resolve(context.Background(), client, host); err == nil {
		t.Fatal("different DNS question accepted")
	}
	client.query = func(string, string) ([]byte, error) { return []byte("invalid DNS fixture"), nil }
	if _, err = resolve(context.Background(), client, host); err == nil {
		t.Fatal("malformed DNS accepted")
	}
	client.query = nil
	if _, err = resolve(context.Background(), client, host); err == nil {
		t.Fatal("DNS failure fell back")
	}
	client.status.BackendState = "NeedsLogin"
	client.queries = 0
	if _, err = resolve(context.Background(), client, host); err == nil || client.queries != 0 {
		t.Fatal("not-ready node queried DNS")
	}
}

func TestReservedOrRoutedTailnetIPsAreNotNodeDestinations(t *testing.T) {
	for _, raw := range []string{"::ffff:100.100.100.100", "fd7a:115c:a1e0::53", "fd7a:115c:a1e0:b1a::c0a8:101"} {
		if _, err := tailnetIPs([]netip.Addr{netip.MustParseAddr(raw)}); err == nil {
			t.Fatal("reserved service or subnet via address accepted")
		}
	}
}

func TestLoginURLAllowlist(t *testing.T) {
	if !validLoginURL("https://login.tailscale.com/a/synthetic-test-only") {
		t.Fatal("official login URL rejected")
	}
	for _, raw := range []string{"http://login.tailscale.com/a/synthetic", "https://login.tailscale.com.evil.example/a/synthetic", "https://login.tailscale.com:443/a/synthetic", "https://user@login.tailscale.com/a/synthetic", "https://login.tailscale.com/admin", "https://login.tailscale.com/a/", "https://login.tailscale.com/a/synthetic#fragment", "https://login.tailscale.com/a/synthetic?query=blocked", "https://login.tailscale.com/a/synthetic/../blocked"} {
		if validLoginURL(raw) {
			t.Fatal("unsafe login URL accepted")
		}
	}
}

func TestRejectInheritedBootstrapCredentials(t *testing.T) {
	keys := []string{"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE", "TS_CONTROL_URL", "TSNET_FORCE_LOGIN"}
	for _, k := range keys {
		t.Setenv(k, "")
	}
	if err := RejectBootstrapEnvironment(); err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		t.Setenv(k, "synthetic-not-a-credential")
		if err := RejectBootstrapEnvironment(); err == nil {
			t.Fatal("inherited bootstrap override accepted")
		}
		t.Setenv(k, "")
	}
}
