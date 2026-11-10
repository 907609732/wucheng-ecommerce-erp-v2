#!/bin/bash
# Create an isolated full-native trial from the same accepted main stage.
set -euo pipefail
helper=$(cd -- "$(dirname -- "$0")" && pwd)
main=$1 work=$2 out=$3 version=$4
trial="$work/stage/wuchengerptrial"
[[ ! -e $trial ]] || { echo 'Trial stage must be a new path.' >&2; exit 1; }
node "$helper/prepare-trial-stage.mjs" "$main" "$trial"
install -m755 "$work/trial-xvfb/Xvfb" "$trial/app/runtime/sysroot/usr/bin/Xvfb"
printf '%s\n' "appID=wuchengerptrial" "version=$version" "xvfb-prefix=/var/apps/wuchengerptrial/target/runtime" "source=accepted main stage $main" > "$out/trial-source-info.txt"
node "$helper/verify-artifact.mjs" "$trial" wuchengerptrial | tee "$out/trial-artifact-verification.json"
cp "$trial/manifest" "$out/trial-MANIFEST-SOURCE.txt"
mkdir -p "$work/trial-fixture" "$work/trial-evidence"
chown -R erpbuild:erpbuild "$trial/app" "$work/trial-fixture" "$work/trial-evidence"
mkdir -p /var/apps/wuchengerptrial
ln -s "$trial/app" /var/apps/wuchengerptrial/target
runuser -u erpbuild -- env ERP_NATIVE_BASE_PREFIX=/app/wuchengerptrial LD_LIBRARY_PATH="$trial/app/runtime/sysroot/usr/lib/x86_64-linux-gnu:$trial/app/runtime/sysroot/lib/x86_64-linux-gnu:$trial/app/runtime/sysroot/usr/lib:$trial/app/runtime/sysroot/lib" "$trial/app/runtime/node/bin/node" "$helper/smoke-native.mjs" --app-root /var/apps/wuchengerptrial/target --data-root "$work/trial-fixture/data" --evidence-dir "$work/trial-evidence" --port-offset 10000
cp -a "$work/trial-evidence" "$out/trial-runtime-evidence"
cp "$out/trial-source-info.txt" "$work/sources/trial-source-info.txt"
mkdir -p "$work/sources/native-build/trial-xvfb" "$out/trial-xvfb"
for dest in "$work/sources/native-build/trial-xvfb" "$out/trial-xvfb"; do
 cp "$work/trial-xvfb/meson-buildoptions.json" "$work/trial-xvfb/meson-log.txt" "$work/trial-xvfb/source-provenance.txt" "$work/trial-xvfb/SHA256SUMS.txt" "$dest/"
done
cd "$out"
find "$trial" -type f ! -path "$trial/manifest" -printf '%P\n' | LC_ALL=C sort > "$work/trial-files.txt"
(cd "$trial"; find . -type f ! -path ./manifest -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$work/trial-payload-sha256.txt"
 (cd "$trial"; find . -type l -printf '%P -> %l\n' | LC_ALL=C sort) > "$work/trial-symlinks.txt"
trial_package="$out/wuchengerptrial.fpk"
[[ ! -e $trial_package ]] || { echo 'Trial FPK output already exists.' >&2; exit 1; }
"$work/downloads/fnpack" build --directory "$trial"
[[ -f $trial_package ]] || { echo 'Expected trial FPK was not produced.' >&2; exit 1; }
sha256sum "$(basename "$trial_package")" > trial-SHA256SUMS.txt
cp "$work/trial-files.txt" "$out/trial-PAYLOAD-FILES.txt"
cp "$work/trial-payload-sha256.txt" "$out/trial-PAYLOAD-SHA256SUMS.txt"
cp "$work/trial-symlinks.txt" "$out/trial-PAYLOAD-SYMLINKS.txt"
mkdir -p "$work/trial-packed/app"
tar -xf "$trial_package" -C "$work/trial-packed"
tar -xzf "$work/trial-packed/app.tgz" -C "$work/trial-packed/app"
node "$helper/verify-artifact.mjs" "$work/trial-packed" wuchengerptrial > "$out/trial-packed-verification.json"
node "$helper/verify-packed-manifest.mjs" "$out/trial-MANIFEST-SOURCE.txt" "$work/trial-packed/manifest" "$work/trial-packed/app.tgz" > "$out/trial-packed-manifest-verification.json"
(cd "$work/trial-packed"; sha256sum --check --strict "$work/trial-payload-sha256.txt" > "$out/trial-packed-payload-check.log")
diff -u "$work/trial-files.txt" <(find "$work/trial-packed" -type f ! -path "$work/trial-packed/manifest" ! -path "$work/trial-packed/app.tgz" -printf '%P\n' | LC_ALL=C sort)
diff -u "$work/trial-symlinks.txt" <(cd "$work/trial-packed"; find . -type l -printf '%P -> %l\n' | LC_ALL=C sort)
printf '%s\n' "version=$version" "commit=$(git -C "$(cd "$helper/../.." && pwd)" rev-parse HEAD)" "run_id=${GITHUB_RUN_ID:-local}" 'scope=isolated full-native trial; synthetic data only' > trial-receipt.txt
