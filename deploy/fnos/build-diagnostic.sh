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
for file in "$helper/diagnostic-cmd/"*; do install -m755 "$file" "$diag/cmd/$(basename "$file")"; done
useradd --create-home --uid 23003 erpdiag
mkdir -p /var/apps/wuchengerpdiag "$work/diag-volume"
ln -s "$diag/app" /var/apps/wuchengerpdiag/target
export TRIM_APPDEST=/var/apps/wuchengerpdiag/target TRIM_APPDEST_VOL="$work/diag-volume" TRIM_USERNAME=erpdiag TRIM_APPNAME=wuchengerpdiag
# Exercise the real root-owned install hook, not an equivalent direct smoke call.
/bin/sh "$diag/cmd/install_callback"
mkdir -p "$out/diagnostic-evidence"
run=$(cat "$work/diag-volume/@wuchengerpdiag-data/active-run")
cp -a "$work/diag-volume/@wuchengerpdiag-data/$run/evidence/." "$out/diagnostic-evidence/"
status=0; /bin/sh "$diag/cmd/main" status || status=$?; [[ $status = 3 ]]
/bin/sh "$diag/cmd/main" stop
# Short bounded run forces TERM while synthetic initialization may still be in
# flight. It must fail honestly, preserve its report and leave no package child.
if /bin/sh "$diag/cmd/acceptance" 1; then echo 'Timed diagnostic unexpectedly passed.' >&2; exit 1; fi
run=$(cat "$work/diag-volume/@wuchengerpdiag-data/active-run")
cp -a "$work/diag-volume/@wuchengerpdiag-data/$run/evidence" "$out/diagnostic-cancel-evidence"
if pgrep -u erpdiag >/dev/null; then ps -fu erpdiag; echo 'Diagnostic cancellation leaked processes.' >&2; exit 1; fi
# No services are claimed running after this install-time one-shot completes.
"$work/downloads/fnpack" build --directory "$diag"
sha256sum "$out/wuchengerpdiag.fpk" >> "$out/SHA256SUMS.txt"
