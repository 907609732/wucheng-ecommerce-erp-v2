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
# No services are claimed running after this install-time one-shot completes.
"$work/downloads/fnpack" build --directory "$diag"
sha256sum "$out/wuchengerpdiag.fpk" >> "$out/SHA256SUMS.txt"
