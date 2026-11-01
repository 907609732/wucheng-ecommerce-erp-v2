# Third-party notices

This component directly depends on the official Tailscale Go SDK (`tailscale.com`
v1.104.2), `golang.org/x/net` and `golang.org/x/sys`. Their module distributions
include their respective licenses; shipping binaries requires preserving the
complete dependency license notices generated from the pinned module graph.

The CONNECT relay and MagicDNS resolution pattern in `internal/sidecar/proxy.go`
and `internal/tsbackend/resolve.go` adapt the official `tailscale/ts-plug`
`cmd/ts-unplug-proxy/ts-unplug-proxy.go`, commit
`14756e741f145d4bcecd725cd022f780f122113d`. The general proxy's unauthenticated
access, arbitrary destinations, public fallback and exit-node selection were not
retained.

Source: https://github.com/tailscale/ts-plug/tree/14756e741f145d4bcecd725cd022f780f122113d

## tailscale/ts-plug license

BSD 3-Clause License

Copyright (c) 2020 Tailscale Inc & AUTHORS.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
