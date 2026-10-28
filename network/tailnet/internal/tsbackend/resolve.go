// Strict MagicDNS resolution adapted from tailscale/ts-plug (BSD-3-Clause).
// Unlike the general upstream proxy, this has no public/OS-DNS fallback.
package tsbackend

import (
	"context"
	"errors"
	"net/netip"
	"slices"
	"strings"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/tsaddr"
	"tailscale.com/types/dnstype"
)

type resolver interface {
	Status(context.Context) (*ipnstate.Status, error)
	QueryDNS(context.Context, string, string) ([]byte, []*dnstype.Resolver, error)
}

func tailnetIPs(ips []netip.Addr) ([]netip.Addr, error) {
	var result []netip.Addr
	for _, ip := range ips {
		ip = ip.Unmap()
		if !tsaddr.IsTailscaleIP(ip) || tsaddr.TailscaleViaRange().Contains(ip) || ip == tsaddr.TailscaleServiceIP() || ip == tsaddr.TailscaleServiceIPv6() {
			return nil, errors.New("non-node DNS destination prohibited")
		}
		if !slices.Contains(result, ip) {
			result = append(result, ip)
		}
	}
	return result, nil
}

func resolve(ctx context.Context, client resolver, host string) ([]netip.Addr, error) {
	status, err := client.Status(ctx)
	if err != nil || status == nil || status.BackendState != "Running" {
		return nil, errors.New("private connection not ready")
	}
	peers := []*ipnstate.PeerStatus{status.Self}
	for _, peer := range status.Peer {
		peers = append(peers, peer)
	}
	for _, peer := range peers {
		if peer != nil && strings.EqualFold(strings.TrimSuffix(peer.DNSName, "."), host) {
			ips, err := tailnetIPs(peer.TailscaleIPs)
			if err != nil {
				return nil, err
			}
			if len(ips) != 0 {
				return ips, nil
			}
		}
	}
	var result []netip.Addr
	for _, queryType := range []string{"A", "AAAA"} {
		raw, _, err := client.QueryDNS(ctx, host+".", queryType)
		if err != nil {
			continue
		}
		ips, err := parseDNS(raw, host, queryType)
		if err != nil {
			return nil, err
		}
		result = append(result, ips...)
	}
	if len(result) == 0 {
		return nil, errors.New("approved MagicDNS name unavailable; no fallback permitted")
	}
	return tailnetIPs(result)
}

func parseDNS(raw []byte, host, queryType string) ([]netip.Addr, error) {
	var message dnsmessage.Message
	if err := message.Unpack(raw); err != nil || !message.Header.Response || message.Header.Truncated || message.Header.RCode != dnsmessage.RCodeSuccess {
		return nil, errors.New("invalid MagicDNS response")
	}
	t := dnsmessage.TypeA
	if queryType == "AAAA" {
		t = dnsmessage.TypeAAAA
	}
	if len(message.Questions) != 1 || !strings.EqualFold(message.Questions[0].Name.String(), host+".") || message.Questions[0].Class != dnsmessage.ClassINET || message.Questions[0].Type != t {
		return nil, errors.New("MagicDNS question mismatch")
	}
	var ips []netip.Addr
	for _, answer := range message.Answers {
		if !strings.EqualFold(answer.Header.Name.String(), host+".") || answer.Header.Class != dnsmessage.ClassINET || answer.Header.Type != t {
			return nil, errors.New("MagicDNS aliases prohibited")
		}
		switch body := answer.Body.(type) {
		case *dnsmessage.AResource:
			ips = append(ips, netip.AddrFrom4(body.A))
		case *dnsmessage.AAAAResource:
			ips = append(ips, netip.AddrFrom16(body.AAAA))
		default:
			return nil, errors.New("unsupported MagicDNS answer")
		}
	}
	return tailnetIPs(ips)
}
