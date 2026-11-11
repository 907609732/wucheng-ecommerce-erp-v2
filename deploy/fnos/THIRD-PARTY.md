# Native third-party delivery

The FPK and its matching `wuchengerp-<version>-corresponding-source.tar.zst` companion form
one distribution. Keep the matching source companion, `SOURCE-SHA256SUMS.txt`,
`THIRD-PARTY.json`, and `SHA256SUMS.txt` available to recipients whenever the FPK
is redistributed. Workflow artifacts expire after 14 days; archive both before
expiry. Every public release must publish both; private workflow artifacts
alone are not a long-term source distribution or a written source offer.

`THIRD-PARTY.json` records every shipped Debian binary package and exact source
version plus npm versions/licenses. Debian copyright files and common GPL/LGPL
texts are in `runtime/licenses`. npm package notices remain inside each package;
Node's complete LICENSE is in `runtime/node/LICENSE`, including its bundled
third-party components. Chromium's complete resources/notices are retained.
noVNC's unmodified upstream `vnc.html`, MPL license, notices and exact source
archive are provided. This distribution uses Debian Chromium, not Chrome for
Testing.

The source companion contains Debian `.dsc`, original source archives and Debian
patch archives for **every** shipped Debian owner, including Chromium, Xvfb,
x11vnc, Mozilla NSS, Mesa, fonts and transitive libraries. `apt-get source
--download-only` verifies them against the signed Debian Sources indexes. It also
contains noVNC's exact source, the native build script/inputs and Xvfb build
options. Xvfb uses patched Debian xorg-server source; only Meson compile options
change, recorded for the main and diagnostic binaries. Standard `lddtree
--copy-to-tree` collects ELF closure; explicit NSS/GTK/Mesa packages account for
dlopen. Host glibc 2.36 and its loader are excluded from the private sysroot.

The npm sharp binary separately bundles LGPL libvips and aggregate libraries.
Its exact sharp-libvips v1.3.4 build recipe, source archives/patches and librsvg
Cargo.lock crate sources accompany this distribution, recorded individually in
`sharp-source-inputs.json`. Rust crate checksums are verified against upstream's
lockfile. Other upstream source archives are obtained over HTTPS with calculated
SHA256s, without detached signature verification. This is distinct from Debian's
signed index verification.

The sales native `@napi-rs/canvas-linux-x64-gnu@1.0.11` binary is checked against
its bundled CycloneDX SBOM. Its Rust component license texts and the enabled
Skia libraries' original notices are included in `runtime/licenses/canvas`.
The companion includes the exact four MPL-2.0 Rust crate sources (`cssparser`,
`cssparser-color`, `cssparser-macros`, `dtoa-short`) checked against that SBOM's
SHA256s. Other Rust source archives are used only to recover original notices;
their full sources are not included. Skia notices/DEPS use its fixed submodule
commit; vendored notices use the component commits recorded by the upstream
Linux SBOM. Missing crate notices are recovered at the crate's `.cargo_vcs_info`
revision. `canvas-source-inputs.json` records URLs, coverage and every delivered
file hash. These HTTPS materials are not separately signature verified.
The fixed Canvas Dockerfile also selects LLVM19 static C++/ABI/unwind runtimes,
which its SBOM omits. Official LLVM19.1.7 root/component license texts are included
as additional notices; the upstream builder image tag does not attest its exact
LLVM patch. These permissive runtime notices do not require an LLVM source tree.

Pinned input provenance in `native-inputs.env`: Node SHA256 is checked against
the official `SHASUMS256.txt` over HTTPS (detached signature not checked here).
fnpack 1.2.3 and noVNC tag archive hashes were calculated from their official HTTPS
downloads, without separately verified upstream signatures. Debian Chromium
deb hashes are pinned and additionally verified by apt's signed metadata. CI
fails on version disappearance or hash drift; it never silently chooses a newer
browser. Sources use official Debian bookworm/bookworm-security repositories.

Optional Unity UVCS is proprietary and **not bundled**. Only an opted-in,
root-owned appcenter hook downloads the exact official 11.0.16.10616-1 amd64 deb,
checks its fixed size/SHA256/metadata, and installs it with no upgrades/removals.
Unity's license and download availability govern that separate installation.
Credentials, UVCS HOME, repository identity, business files, configuration,
profiles and secrets must never be included in these artifacts.

Build tooling follows the [official fnpack CLI](https://developer.fnnas.com/docs/cli/fnpack/),
[Debian source distribution](https://www.debian.org/doc/manuals/debian-reference/ch02.en.html),
[Node releases](https://nodejs.org/dist/v24.22.2/), and
[noVNC v1.6.0](https://github.com/novnc/noVNC/tree/v1.6.0).
