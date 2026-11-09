#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sysroot="$root/runtime/sysroot"
export LD_LIBRARY_PATH="$sysroot/usr/lib/x86_64-linux-gnu:$sysroot/lib/x86_64-linux-gnu:$sysroot/usr/lib:$sysroot/lib"
exec "$root/runtime/node/bin/node" "$root/erp/server/environment.mjs" "$@"
