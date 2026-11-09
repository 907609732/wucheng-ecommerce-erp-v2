#!/bin/bash
# Build host only, Debian 12 amd64. Never run this on the NAS.
set -euo pipefail
helper=$(cd -- "$(dirname -- "$0")" && pwd)
source "$helper/native-inputs.env"
runtime=$1
work=$2
mkdir -p "$runtime/sysroot" "$work/debs" "$work/sources" "$work/xorg"
sysroot="$runtime/sysroot"

# apt validates Debian InRelease signatures and package hashes. Sources and
# binaries use the same official suites, with no trusted=yes or key bypass.
cat > /etc/apt/sources.list.d/wuchengerp-source.sources <<'EOF'
Types: deb-src
URIs: https://deb.debian.org/debian
Suites: bookworm bookworm-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb-src
URIs: https://security.debian.org/debian-security
Suites: bookworm-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
apt-get update
apt-get install -y --no-install-recommends \
  build-essential meson ninja-build pkg-config pax-utils=1.3.7-1 python3-pyelftools \
  "chromium=$CHROMIUM_VERSION" "chromium-common=$CHROMIUM_VERSION" \
  x11vnc xauth x11-xkb-utils xkb-data xfonts-base xfonts-encodings fonts-noto-cjk fontconfig \
  "xvfb=$XORG_VERSION" \
  libnss3 libnspr4 libgtk-3-0 libasound2 libgl1-mesa-dri libegl-mesa0 libgles2 libegl1 libgl1 libglx0 libopengl0 \
  libnss-mymachines libnss-mdns dconf-gsettings-backend libva2 libva-drm2 \
  ca-certificates zstd strace util-linux
apt-get build-dep -y --no-install-recommends "xorg-server=$XORG_VERSION"
(cd "$work/debs"; apt-get download "chromium=$CHROMIUM_VERSION" "chromium-common=$CHROMIUM_VERSION")
printf '%s  %s\n' "$CHROMIUM_SHA256" "$work/debs/chromium_${CHROMIUM_VERSION}_amd64.deb" "$CHROMIUM_COMMON_SHA256" "$work/debs/chromium-common_${CHROMIUM_VERSION}_amd64.deb" | sha256sum --check --strict
(cd "$work/xorg"; apt-get source "xorg-server=$XORG_VERSION")
xorg=$(find "$work/xorg" -mindepth 1 -maxdepth 1 -type d -name 'xorg-server-*' -print -quit)
build_xvfb() {
 local package=$1 build=$2
 meson setup "$build" "$xorg" \
  --prefix="/var/apps/$package/target/runtime" \
  -Dxorg=false -Dxephyr=false -Dxnest=false -Dxwin=false -Dxquartz=false -Dxvfb=true \
  -Dglamor=false -Dglx=false -Dudev=false -Dudev_kms=false -Dsystemd_logind=false \
  -Ddri1=false -Ddri2=false -Ddri3=false -Ddrm=false \
  -Ddocs=false -Ddevel-docs=false -Dlisten_tcp=false \
  -Dxkb_bin_dir="/var/apps/$package/target/runtime/sysroot/usr/bin" \
  -Dxkb_dir="/var/apps/$package/target/runtime/sysroot/usr/share/X11/xkb" -Dxkb_output_dir=/tmp
 meson compile -C "$build" -j 2
}
build_xvfb wuchengerp "$xorg/build-native"
build_xvfb wuchengerpdiag "$xorg/build-diag"
mkdir -p "$work/diagnostic"
install -m755 "$xorg/build-diag/hw/vfb/Xvfb" "$work/diagnostic/Xvfb"
cp "$xorg/build-diag/meson-info/intro-buildoptions.json" "$work/diagnostic/meson-buildoptions.json"
(cd "$work/diagnostic"; sha256sum Xvfb meson-buildoptions.json > SHA256SUMS.txt)
mkdir -p "$sysroot/usr/bin"
install -m755 "$xorg/build-native/hw/vfb/Xvfb" "$sysroot/usr/bin/Xvfb"

# lddtree is the Debian pax-utils implementation, not a hand-written ELF reader.
lddtree --help | grep -q -- --copy-to-tree
lddtree --copy-to-tree "$sysroot" --bindir /usr/bin /usr/bin/x11vnc /usr/bin/xauth /usr/bin/xkbcomp
# Collect dependency closure without relocating Chromium's executable/resources.
mkdir -p "$runtime/chromium"
cp -a /usr/lib/chromium/. "$runtime/chromium/"
mv "$runtime/chromium/chromium" "$runtime/chromium/chrome"
lddtree --copy-to-tree "$sysroot" /usr/lib/chromium/chromium /usr/lib/chromium/libvulkan.so.1 /usr/lib/chromium/libvk_swiftshader.so "$runtime/node/bin/node" "$xorg/build-native/hw/vfb/Xvfb"
rm -rf -- "$sysroot/usr/lib/chromium" "${sysroot}${runtime}" "${sysroot}${work}"
# Mozilla NSS differs from glibc's external NSS plugins. Both those plugins and
# GIO/VA backends can be loaded by name even when lddtree sees no DT_NEEDED edge.
extras=()
for package in libnss3 libnspr4 libgtk-3-0 libasound2 libgl1-mesa-dri libegl-mesa0 libgles2 libegl1 libgl1 libglx0 libopengl0 libnss-mymachines libnss-mdns dconf-gsettings-backend libva2 libva-drm2; do
 while IFS= read -r file; do
  if [[ -f "$file" && "$file" =~ \.so(\.|$) ]]; then extras+=("$file"); fi
 done < <(dpkg-query -L "$package")
done
lddtree --copy-to-tree "$sysroot" "${extras[@]}"
for p in /usr/share/X11/xkb /usr/share/X11/locale /usr/share/fonts/X11/misc /usr/share/fonts/X11/encodings /usr/share/fonts/opentype/noto /usr/share/glvnd/egl_vendor.d /etc/fonts; do
 mkdir -p "$sysroot$(dirname "$p")"; cp -aL "$p" "$sysroot$p"
done
# Debian's postinstall encodings index contains host absolute paths. Regenerate
# the font metadata with standard mkfontdir and relative paths for both packages.
(cd "$sysroot/usr/share/fonts/X11/misc"; mkfontdir -e ../encodings -e ../encodings/large .)
# Keep the NAS loader/glibc 2.36 family. Never mix a private glibc and host loader.
find "$sysroot" \( -type f -o -type l \) \( -name 'ld-linux*' -o -name 'libc.so*' -o -name 'libm.so*' -o -name 'libmvec.so*' -o -name 'libpthread.so*' -o -name 'libdl.so*' -o -name 'librt.so*' -o -name 'libresolv.so*' -o -name 'libutil.so*' -o -name 'libanl.so*' -o -name 'libBrokenLocale.so*' -o -name 'libnss_files.so*' -o -name 'libnss_dns.so*' -o -name 'libnss_compat.so*' -o -name 'libnss_hesiod.so*' \) -delete
# Source ownership is derived from every copied Debian path, including resource
# data and dlopen libraries. Xvfb is custom-built from the patched xorg source.
printf '%s\n' xvfb > "$work/owners.txt"
while IFS= read -r -d '' file; do
 original=${file#"$sysroot"}
 candidates=("$original")
 # fontconfig enables packaged configuration through post-install symlinks;
 # dpkg owns the link target even when it does not inventory the enabled link.
 if [[ -e $original ]]; then candidates+=("$(readlink -f "$original")"); fi
 # Debian merged-/usr may resolve an ELF through /lib while its dpkg inventory
 # owns /usr/lib (and vice versa). Query both standard paths, never drop owners.
 case "$original" in /usr/lib/*) candidates+=("${original#/usr}");; /lib/*) candidates+=("/usr$original");; esac
 found=''
 for candidate in "${candidates[@]}"; do
  if found=$(dpkg-query -S "$candidate" 2>/dev/null); then break; fi
 done
 if [[ -n $found ]]; then
  printf '%s\n' "$found" | sed 's/: \/.*//' >> "$work/owners.txt"
 else
  case "$original" in
   /usr/share/fonts/X11/misc/fonts.alias|/usr/share/fonts/X11/misc/fonts.dir|/usr/share/fonts/X11/misc/fonts.scale|/usr/share/fonts/X11/misc/encodings.dir|/usr/share/fonts/X11/encodings/encodings.dir|/usr/share/fonts/X11/encodings/large/encodings.dir)
    printf '%s\n' xfonts-base xfonts-encodings xfonts-utils >> "$work/owners.txt";;
   *) printf 'Unowned runtime file: %s\n' "$original" | tee -a "$work/unowned-paths.txt" >&2;;
  esac
 fi
done < <(find "$sysroot" \( -type f -o -type l \) -print0)
[[ ! -s "$work/unowned-paths.txt" ]] || { echo 'Review every unowned runtime path before packaging.' >&2; exit 1; }
printf '%s\n' chromium chromium-common >> "$work/owners.txt"
sort -u -o "$work/owners.txt" "$work/owners.txt"
# Record every shipped path that has no dpkg ownership (only compiled Xvfb is
# allowed); this prevents a newly added unlicensed loose binary slipping in.
"$runtime/node/bin/node" "$helper/collect-native-sources.mjs" "$runtime" "$work"
cp "$helper/prepare-native-runtime.sh" "$helper/native-inputs.env" "$work/sources/"
cp "$xorg/build-native/meson-logs/meson-log.txt" "$work/xvfb-meson-log.txt"
