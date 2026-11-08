#!/bin/bash
# Called only by build-native with an already accepted main stage/runtime.
set -euo pipefail
helper=$(cd -- "$(dirname -- "$0")" && pwd)
stage=$1; work=$2; out=$3
diag="$work/stage/wuchengerpdiag"
mkdir -p "$diag/app" "$diag/config" "$diag/cmd"
cp -a "$stage/app/." "$diag/app/"
rm -rf "$diag/app/ui"
install -m755 "$work/diagnostic/Xvfb" "$diag/app/runtime/sysroot/usr/bin/Xvfb"
cp "$helper/smoke-native.mjs" "$diag/app/smoke-native.mjs"
cp "$helper/smoke-checks.mjs" "$diag/app/smoke-checks.mjs"
"$stage/app/runtime/node/bin/node" --input-type=module - "$diag/app/THIRD-PARTY.json" <<'EOF'
import fs from 'node:fs';const f=process.argv[2],j=JSON.parse(fs.readFileSync(f));j.packageName='wuchengerpdiag';j.xvfbBuild.xkbBinDir='/var/apps/wuchengerpdiag/target/runtime/sysroot/usr/bin';j.xvfbBuild.xkbDir='/var/apps/wuchengerpdiag/target/runtime/sysroot/usr/share/X11/xkb';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');
EOF
cp "$stage/ICON.PNG" "$stage/ICON_256.PNG" "$diag/"
cat > "$diag/manifest" <<'EOF'
appname=wuchengerpdiag
version=0.15.0
display_name=五成ERP原生隔离验收（测试）
desc=仅合成数据的有界原生诊断；结果保留在独立私有目录；非正式服务。
platform=x86
source=thirdparty
maintainer=Wucheng
distributor=Wucheng
os_min_version=1.1.3100
ctl_stop=true
disable_authorization_path=true
EOF
printf '%s\n' '{"defaults":{"run-as":"root"}}' > "$diag/config/privilege"
printf '%s\n' '{}' > "$diag/config/resource"
for relative in config/privilege config/resource; do install -D -m644 "$diag/$relative" "$diag/app/$relative"; done
for file in "$helper/diagnostic-cmd/"*; do install -m755 "$file" "$diag/cmd/$(basename "$file")"; done
useradd --create-home --uid 23003 erpdiag
mkdir -p /var/apps/wuchengerpdiag "$work/diag-volume"
ln -s "$diag/app" /var/apps/wuchengerpdiag/target
export TRIM_APPDEST=/var/apps/wuchengerpdiag/target TRIM_APPDEST_VOL="$work/diag-volume" TRIM_USERNAME=erpdiag TRIM_APPNAME=wuchengerpdiag
ERP_DIAG_STOP_CI=1 /usr/bin/python3 -I -B "$helper/check-diagnostic-stop.py" "$diag/cmd" "$work" "$out"
# Exercise the real root-owned install hook, not an equivalent direct smoke call.
/bin/sh "$diag/cmd/install_callback"
mkdir -p "$out/diagnostic-evidence"
run=$(cat "$work/diag-volume/@wuchengerpdiag-data/active-run")
cp -a "$work/diag-volume/@wuchengerpdiag-data/$run/evidence/." "$out/diagnostic-evidence/"
status=0; /bin/sh "$diag/cmd/main" status || status=$?; [[ $status = 3 ]]
/bin/sh "$diag/cmd/main" stop
# Establish a real clean boundary between the full diagnostic and the forced
# cancellation generation. A previous leak must not be attributed to the latter.
if pgrep -u erpdiag >/dev/null; then ps -o pid,ppid,lstart,args -u erpdiag; echo 'Full diagnostic left package processes before timeout case.' >&2; exit 1; fi
printf '%s\n' '{"uid":23003,"processes":[],"checkedAfterFullDiagnostic":true}' > "$out/diagnostic-timeout-baseline.json"
# Short bounded run forces TERM while synthetic initialization may still be in
# flight. It must fail honestly, preserve its report and leave no package child.
if /bin/sh "$diag/cmd/acceptance" 1; then echo 'Timed diagnostic unexpectedly passed.' >&2; exit 1; fi
run=$(cat "$work/diag-volume/@wuchengerpdiag-data/active-run")
cp -a "$work/diag-volume/@wuchengerpdiag-data/$run/evidence" "$out/diagnostic-cancel-evidence"
if pgrep -u erpdiag >/dev/null; then ps -fu erpdiag; echo 'Diagnostic cancellation leaked processes.' >&2; exit 1; fi
# No services are claimed running after this install-time one-shot completes.
cp "$diag/manifest" "$out/DIAGNOSTIC-MANIFEST-SOURCE.txt"
(cd "$diag"; find . -type f ! -path ./manifest -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$out/DIAGNOSTIC-PAYLOAD-SHA256SUMS.txt")
find "$diag" -type f ! -path "$diag/manifest" -printf '%P\n' | LC_ALL=C sort > "$out/DIAGNOSTIC-PAYLOAD-FILES.txt"
(cd "$diag"; find . -type l -printf '%P -> %l\n' | LC_ALL=C sort) > "$out/DIAGNOSTIC-PAYLOAD-SYMLINKS.txt"
"$work/downloads/fnpack" build --directory "$diag"
[[ -s "$out/wuchengerpdiag.fpk" ]] || { echo 'Official diagnostic FPK was not produced.' >&2; exit 1; }
mkdir -p "$work/unpacked-diag/app"
tar -xf "$out/wuchengerpdiag.fpk" -C "$work/unpacked-diag"
tar -xzf "$work/unpacked-diag/app.tgz" -C "$work/unpacked-diag/app"
"$stage/app/runtime/node/bin/node" "$helper/verify-packed-manifest.mjs" "$out/DIAGNOSTIC-MANIFEST-SOURCE.txt" "$work/unpacked-diag/manifest" "$work/unpacked-diag/app.tgz" > "$out/diagnostic-packed-manifest-verification.json"
rm "$work/unpacked-diag/app.tgz"
(cd "$work/unpacked-diag"; sha256sum --check --strict "$out/DIAGNOSTIC-PAYLOAD-SHA256SUMS.txt" > "$out/diagnostic-packed-payload-checks.log")
diff -u "$out/DIAGNOSTIC-PAYLOAD-FILES.txt" <(find "$work/unpacked-diag" -type f ! -path "$work/unpacked-diag/manifest" -printf '%P\n' | LC_ALL=C sort)
diff -u "$out/DIAGNOSTIC-PAYLOAD-SYMLINKS.txt" <(cd "$work/unpacked-diag"; find . -type l -printf '%P -> %l\n' | LC_ALL=C sort)
(cd "$out"; sha256sum wuchengerpdiag.fpk >> SHA256SUMS.txt)
