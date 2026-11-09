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
[[ $work =~ ^/build/erp\.[A-Za-z0-9]+$ && -d $work ]]
app="$work/unpacked/app"
# fnOS package accounts can have a passwd HOME without an existing directory.
# Both packed payload checks must work without root creating that directory.
useradd --no-create-home --uid 23001 erpbuild
useradd --no-create-home --uid 23003 erpdiag
for user in erpbuild erpdiag; do [[ ! -e $(getent passwd "$user" | cut -d: -f6) ]]; done
runuser -u erpbuild -- unshare --user --map-root-user true
mkdir -p /var/apps/wuchengerp /var/apps/wuchengerpdiag "$work/clean-fixture" /output/release/clean-runtime-evidence
ln -s "$app" /var/apps/wuchengerp/target
ln -s "$work/unpacked-diag/app" /var/apps/wuchengerpdiag/target
chown erpbuild:erpbuild "$app"
chown erpbuild:erpbuild "$work/clean-fixture" /output/release/clean-runtime-evidence
libs="$app/runtime/sysroot/usr/lib/x86_64-linux-gnu:$app/runtime/sysroot/lib/x86_64-linux-gnu:$app/runtime/sysroot/usr/lib:$app/runtime/sysroot/lib"
# Keep this image clean; hostile desktop environment variables must not make
# either packed main or diagnostic runtime fall back to those absent host paths.
export GIO_MODULE_DIR=/usr/lib/x86_64-linux-gnu/gio/modules GIO_EXTRA_MODULES=/usr/lib/x86_64-linux-gnu/gio/modules
export VK_DRIVER_FILES=/usr/share/vulkan/icd.d VK_ICD_FILENAMES=/usr/share/vulkan/icd.d VK_ADD_DRIVER_FILES=/usr/share/vulkan/icd.d
export VK_LAYER_PATH=/usr/share/vulkan/explicit_layer.d VK_IMPLICIT_LAYER_PATH=/usr/share/vulkan/implicit_layer.d
export LIBVA_DRIVERS_PATH=/usr/lib/x86_64-linux-gnu/dri
runuser -u erpbuild -- env LD_LIBRARY_PATH="$libs" "$app/runtime/node/bin/node" /src/deploy/fnos/smoke-native.mjs --app-root "$app" --data-root "$work/clean-fixture/data" --evidence-dir /output/release/clean-runtime-evidence --port-offset 1000
mkdir -p "$work/clean-dv"
export TRIM_APPDEST=/var/apps/wuchengerpdiag/target TRIM_APPDEST_VOL="$work/clean-dv" TRIM_USERNAME=erpdiag TRIM_APPNAME=wuchengerpdiag
/bin/sh "$work/unpacked-diag/cmd/install_callback"
run=$(cat "$work/clean-dv/@wuchengerpdiag-data/active-run")
cp -a "$work/clean-dv/@wuchengerpdiag-data/$run/evidence" /output/release/clean-diagnostic-evidence
status=0; /bin/sh "$work/unpacked-diag/cmd/main" status || status=$?; [[ $status = 3 ]]
/bin/sh "$work/unpacked-diag/cmd/main" stop
