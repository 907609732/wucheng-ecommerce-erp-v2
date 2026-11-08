#!/bin/bash
# Complete official Native FPK. CI/build machine only; never run on production NAS.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
helper=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd "$helper/../.." && pwd)
source "$helper/native-inputs.env"
[[ $(id -u) = 0 && $(uname -m) = x86_64 ]] || { echo 'Build requires ephemeral Debian 12 amd64 root (not NAS).' >&2; exit 1; }
source /etc/os-release
[[ $ID = debian && $VERSION_ID = 12 ]] || { echo 'Build requires Debian bookworm/glibc 2.36.' >&2; exit 1; }
[[ -x /usr/bin/python3 ]] || { echo 'Build prerequisite: install official Debian python3.' >&2; exit 1; }
[[ $(getconf GNU_LIBC_VERSION) = 'glibc 2.36' ]]
out=$(realpath -m -- "${1:-/tmp/wuchengerp-native-output}")
case "$out/" in "$repo/"*) echo 'Output must be outside source tree.' >&2; exit 1;; esac
[[ ! -e $out ]] || { echo 'Output must be a new directory.' >&2; exit 1; }
mkdir -p "$out"; work=$(mktemp -d "${ERP_BUILD_WORK_ROOT:-/tmp}/wuchengerp-build.XXXXXXXX")
finish() {
 local result=$?
 if [[ $result != 0 ]]; then
  set +e
  [[ ! -d "$work/smoke-evidence" ]] || cp -a "$work/smoke-evidence" "$out/smoke-failure-evidence"
  if [[ -d "$work/diag-volume/@wuchengerpdiag-data" ]]; then
   mkdir -p "$out/diagnostic-failure-evidence"
   for evidence in "$work/diag-volume/@wuchengerpdiag-data"/run-*/evidence; do
    [[ ! -d $evidence ]] || cp -a "$evidence" "$out/diagnostic-failure-evidence/$(basename "$(dirname "$evidence")")"
   done
  fi
 fi
 exit "$result"
}
trap finish EXIT
printf '%s\n' "$work" > "$out/BUILD-WORKDIR.txt"
mkdir -p "$work/downloads" "$work/sources" "$work/stage/wuchengerp/app/runtime"
stage="$work/stage/wuchengerp"; runtime="$stage/app/runtime"
fetch() { curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$3" "$1"; printf '%s  %s\n' "$2" "$3" | sha256sum --check --strict; }
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" "$work/downloads/node.tar.xz"
curl --fail --location --proto '=https' --output "$work/downloads/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
grep -Fx "$NODE_SHA256  node-v$NODE_VERSION-linux-x64.tar.xz" "$work/downloads/SHASUMS256.txt"
mkdir -p "$runtime/node"; tar -xJf "$work/downloads/node.tar.xz" --strip-components=1 -C "$runtime/node"
export PATH="$runtime/node/bin:$PATH"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
fetch "https://static2.fnnas.com/fnpack/fnpack-$FNPACK_VERSION-linux-amd64" "$FNPACK_SHA256" "$work/downloads/fnpack"
chmod 755 "$work/downloads/fnpack"
"$work/downloads/fnpack" --help | tee "$out/fnpack-help.txt"
grep -q '1.2.3' "$out/fnpack-help.txt"
fetch "https://codeload.github.com/novnc/noVNC/tar.gz/refs/tags/v$NOVNC_VERSION" "$NOVNC_SHA256" "$work/sources/noVNC-v$NOVNC_VERSION.tar.gz"
mkdir -p "$runtime/novnc"; tar -xzf "$work/sources/noVNC-v$NOVNC_VERSION.tar.gz" --strip-components=1 -C "$runtime/novnc"
rm -rf "$runtime/novnc/.github" "$runtime/novnc/tests"
# Explicit metadata allowlist, never a deployed app/data folder.
for relative in manifest config/privilege config/resource app/ui/config; do install -D -m644 "$helper/wuchengerp/$relative" "$stage/$relative"; done
for folder in cmd wizard; do
 while IFS= read -r relative; do
  file="$repo/$relative"
  [[ -f $file && ! -L $file ]] || { echo 'Linked/nonfile package metadata refused.' >&2; exit 1; }
  install -D -m755 "$file" "$stage/$folder/$(basename "$file")"
 done < <(git -C "$repo" ls-files "deploy/fnos/wuchengerp/$folder/")
done
for p in ICON.PNG ICON_256.PNG app/ui/images/icon_64.png app/ui/images/icon_256.png; do install -D -m644 "$repo/shared/ui/loading-logo.png" "$stage/$p"; done
bash "$helper/prepare-native-runtime.sh" "$runtime" "$work"
# Existing accepted-release builder installs production Linux dependencies.
cd "$repo"
export npm_execpath="$runtime/node/lib/node_modules/npm/bin/npm-cli.js"
node server/release.mjs "$stage/app/erp"
node "$helper/collect-sharp-sources.mjs" "$stage" "$work"
node "$helper/write-native-manifest.mjs" "$stage" "$work"
node "$helper/verify-artifact.mjs" "$stage" | tee "$out/artifact-verification.json"
cp "$stage/app/THIRD-PARTY.json" "$out/THIRD-PARTY.json"
cp "$work/debian-packages.json" "$out/debian-packages.json"
cp "$work/sharp-source-inputs.json" "$out/sharp-source-inputs.json"
cp "$work/xvfb-meson-log.txt" "$out/xvfb-meson-log.txt"
cp "$helper/native-inputs.env" "$out/INPUTS.env"
cp -a "$work/diagnostic" "$out/diagnostic-xvfb"
find "$stage" -type f -printf '%P\n' | LC_ALL=C sort > "$out/PAYLOAD-FILES.txt"
(cd "$stage"; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$out/PAYLOAD-SHA256SUMS.txt"
# Real package-user checks. This canonical path exists only in disposable CI.
useradd --create-home --uid 23001 erpbuild
mkdir -p /var/apps/wuchengerp
ln -s "$stage/app" /var/apps/wuchengerp/target
chmod 755 "$work"
chown erpbuild:erpbuild "$stage/app"
mkdir -p "$work/fixture" "$work/smoke-evidence"; chown erpbuild:erpbuild "$work/fixture" "$work/smoke-evidence"
runuser -u erpbuild -- env PATH="$PATH" "$runtime/node/bin/node" "$helper/smoke-native.mjs" --app-root /var/apps/wuchengerp/target --data-root "$work/fixture/data" --evidence-dir "$work/smoke-evidence" --port-offset 1000
strace -f -e trace=%file -o "$out/private-runtime-file-probe.log" runuser -u erpbuild -- env LD_LIBRARY_PATH="$runtime/sysroot/usr/lib/x86_64-linux-gnu:$runtime/sysroot/lib/x86_64-linux-gnu:$runtime/sysroot/usr/lib:$runtime/sysroot/lib" "$runtime/chromium/chrome" --version
cp -a "$work/smoke-evidence" "$out/smoke-evidence"
# The smoke uses a synthetic data root outside the stage and is never packaged.
node "$helper/verify-artifact.mjs" "$stage"
cd "$out"
"$work/downloads/fnpack" build --directory "$stage"
mapfile -t packages < <(find "$out" -maxdepth 1 -name '*.fpk' -type f)
[[ ${#packages[@]} = 1 ]] || { echo 'Official fnpack did not produce exactly one FPK.' >&2; exit 1; }
mkdir -p "$work/unpacked/app"
tar -xf "${packages[0]}" -C "$work/unpacked"
tar -xzf "$work/unpacked/app.tgz" -C "$work/unpacked/app"
rm "$work/unpacked/app.tgz"
node "$helper/verify-artifact.mjs" "$work/unpacked" > "$out/packed-artifact-verification.json"
(cd "$work/unpacked"; sha256sum --check --strict "$out/PAYLOAD-SHA256SUMS.txt" > "$out/packed-payload-checks.log")
sha256sum "$(basename "${packages[0]}")" > SHA256SUMS.txt
bash "$helper/build-diagnostic.sh" "$stage" "$work" "$out"
# Sources are separate companions and must stay together with any redistribution.
cp "$stage/app/THIRD-PARTY.json" "$work/sources/"
cp "$helper/THIRD-PARTY.md" "$work/sources/README.md"
mkdir -p "$work/sources/native-build"; cp "$helper/"*.sh "$helper/"*.mjs "$helper/native-inputs.env" "$work/sources/native-build/"
cp "$work/diagnostic/meson-buildoptions.json" "$work/sources/native-build/diag-meson-buildoptions.json"
(cd "$work/sources"; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$out/SOURCE-SHA256SUMS.txt")
tar --zstd -cf "$out/wuchengerp-0.15.0-corresponding-source.tar.zst" -C "$work/sources" .
sha256sum wuchengerp-0.15.0-corresponding-source.tar.zst >> SHA256SUMS.txt
printf '%s\n' "commit=$(git -C "$repo" rev-parse HEAD)" "run_id=${GITHUB_RUN_ID:-local}" 'platform=linux/amd64' 'libc=host glibc 2.36' > BUILD-INFO.txt
