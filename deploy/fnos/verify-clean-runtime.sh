#!/bin/bash
# A fresh Debian12 runtime container: no builder X11/GTK/NSS/fonts may mask gaps.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3 ca-certificates util-linux
for file in /usr/lib/x86_64-linux-gnu/libX11.so.6 /usr/lib/x86_64-linux-gnu/libgtk-3.so.0 /usr/lib/x86_64-linux-gnu/libnss3.so /usr/share/fonts /usr/share/X11/xkb; do
 [[ ! -e $file ]] || { echo "Clean runtime unexpectedly contains builder resource $file" >&2; exit 1; }
done
work=$(cat /output/release/BUILD-WORKDIR.txt)
[[ $work =~ ^/build/wuchengerp-build\.[A-Za-z0-9]+$ && -d $work ]]
app="$work/stage/wuchengerp/app"
useradd --create-home --uid 23001 erpbuild
useradd --create-home --uid 23003 erpdiag
mkdir -p /var/apps/wuchengerp /var/apps/wuchengerpdiag "$work/clean-fixture" /output/release/clean-runtime-evidence
ln -s "$app" /var/apps/wuchengerp/target
ln -s "$work/stage/wuchengerpdiag/app" /var/apps/wuchengerpdiag/target
chown erpbuild:erpbuild "$work/clean-fixture" /output/release/clean-runtime-evidence
libs="$app/runtime/sysroot/usr/lib/x86_64-linux-gnu:$app/runtime/sysroot/lib/x86_64-linux-gnu:$app/runtime/sysroot/usr/lib:$app/runtime/sysroot/lib"
runuser -u erpbuild -- env LD_LIBRARY_PATH="$libs" "$app/runtime/node/bin/node" /src/deploy/fnos/smoke-native.mjs --app-root "$app" --data-root "$work/clean-fixture/data" --evidence-dir /output/release/clean-runtime-evidence --port-offset 1000
mkdir -p "$work/clean-diag-volume"
export TRIM_APPDEST=/var/apps/wuchengerpdiag/target TRIM_APPDEST_VOL="$work/clean-diag-volume" TRIM_USERNAME=erpdiag TRIM_APPNAME=wuchengerpdiag
/bin/sh "$work/stage/wuchengerpdiag/cmd/install_callback"
run=$(cat "$work/clean-diag-volume/@wuchengerpdiag-data/active-run")
cp -a "$work/clean-diag-volume/@wuchengerpdiag-data/$run/evidence" /output/release/clean-diagnostic-evidence
status=0; /bin/sh "$work/stage/wuchengerpdiag/cmd/main" status || status=$?; [[ $status = 3 ]]
/bin/sh "$work/stage/wuchengerpdiag/cmd/main" stop
