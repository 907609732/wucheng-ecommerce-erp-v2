#!/bin/bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
if [[ $# != 4 ]]; then echo 'usage: build-environment.sh <accepted-erp> <prepared-runtime> <linux-xvfb-dir> <new-output-dir>' >&2; exit 2; fi
release=$(realpath -- "$1"); runtime=$(realpath -- "$2"); xvfb=$(realpath -- "$3"); out=$(realpath -m -- "$4")
[[ ! -e $out ]] || { echo 'Linux output must be a new directory.' >&2; exit 1; }
[[ -x $runtime/node/bin/node && -f $xvfb/Xvfb && -f $xvfb/meson-buildoptions.json && -f $xvfb/source-provenance.txt ]] || { echo 'Prepared Linux runtime or Xvfb provenance is incomplete.' >&2; exit 1; }
commit=${GITHUB_SHA:-$(git -C "$repo" rev-parse HEAD)}
run=${GITHUB_RUN_ID:-1}
mkdir -p "$(dirname "$out")"
mkdir "$out"; payload="$out/payload"
node "$repo/deploy/environments/package.mjs" --target linux-x64 --release "$release" --runtime "$runtime" --output "$payload" --commit "$commit" --run "$run"
install -m755 "$xvfb/Xvfb" "$payload/runtime/sysroot/usr/bin/Xvfb"
mkdir -p "$payload/runtime/linux-xvfb-build"
install -m644 "$xvfb/meson-buildoptions.json" "$xvfb/meson-log.txt" "$xvfb/source-provenance.txt" "$xvfb/SHA256SUMS.txt" "$payload/runtime/linux-xvfb-build/"
mkdir -p "$payload/deploy"
cp "$repo/deploy/environments/templates/linux-x64/README.md" "$repo/deploy/environments/templates/linux-x64/wuchengerp.service" "$payload/deploy/"
install -m755 "$repo/deploy/linux/erp.sh" "$payload/erp.sh"
cp "$repo/deploy/fnos/THIRD-PARTY.md" "$payload/THIRD-PARTY.md"
node "$repo/deploy/environments/metadata.mjs" --verify-source "$payload/erp" "$payload/environment-build.json"
node - "$payload/environment-build.json" "$out/environment-build.json" <<'JS'
import fs from 'node:fs';const [src,dst]=process.argv.slice(2);fs.copyFileSync(src,dst);
JS
[[ -n ${ERP_FNOS_SOURCE_COMPANION:-} && -f $ERP_FNOS_SOURCE_COMPANION ]] || { echo '同次 fnOS corresponding-source archive is required.' >&2; exit 1; }
source_sha=$(sha256sum "$ERP_FNOS_SOURCE_COMPANION" | cut -d' ' -f1)
printf 'path=%s\nsha256=%s\n' "$(basename "$ERP_FNOS_SOURCE_COMPANION")" "$source_sha" | tee "$payload/source-companion.txt" "$out/source-companion.txt" >/dev/null
version=$(node - "$payload/environment-build.json" <<'JS'
import fs from 'node:fs';console.log(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).version);
JS
)
archive="$out/wuchengerp-$version-linux-x64.tar.gz"
tar -C "$payload" -czf "$archive" .
(cd "$out"; sha256sum "$(basename "$archive")") > "$archive.sha256"
# The canonical prefix is reserved for this isolated smoke only. A pre-existing
# installation or symlink is an unconditional refusal, never replaced.
canonical=/opt/wuchengerp
[[ ! -e $canonical && ! -L $canonical ]] || { echo 'Refusing pre-existing /opt/wuchengerp.' >&2; exit 1; }
mkdir -m755 "$canonical"
marker="$canonical/.codex-linux-smoke-owner"
printf '%s\n' "$archive" > "$marker"
allow_canonical_cleanup=true
cleanup_canonical(){
 if [[ -f $marker && $(cat "$marker") == "$archive" && ! -L $canonical ]]; then
  if [[ $allow_canonical_cleanup == true ]]; then rm -rf -- "$canonical"; else echo "Retaining $canonical because smoke cleanup was not confirmed." >&2; fi
 fi
}
trap cleanup_canonical EXIT
tar -xzf "$archive" -C "$canonical"
mkdir -p "$out/.linux-acceptance"; chown erpbuild:erpbuild "$out/.linux-acceptance"
libs="$canonical/runtime/sysroot/usr/lib/x86_64-linux-gnu:$canonical/runtime/sysroot/lib/x86_64-linux-gnu:$canonical/runtime/sysroot/usr/lib:$canonical/runtime/sysroot/lib"
set +e
runuser -u erpbuild -- env LD_LIBRARY_PATH="$libs" "$canonical/runtime/node/bin/node" "$repo/deploy/linux/smoke-environment.mjs" "$canonical" "$out/.linux-acceptance" "$canonical/environment-build.json"
smoke_status=$?
set -e
[[ ! -f $out/.linux-acceptance/environment-acceptance.json ]] || cp "$out/.linux-acceptance/environment-acceptance.json" "$out/environment-acceptance.json"
for evidence in chrome-sandbox.txt loaded-libraries.json; do
 [[ ! -f $out/.linux-acceptance/$evidence ]] || cp "$out/.linux-acceptance/$evidence" "$out/$evidence"
done
cleanup_value=false
if [[ -f $out/environment-acceptance.json ]]; then
 cleanup_value=$(node - "$out/environment-acceptance.json" <<'JS'
import fs from 'node:fs';console.log(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).cleanupComplete===true?'true':'false');
JS
)
 [[ $cleanup_value == true ]] || allow_canonical_cleanup=false
else
 allow_canonical_cleanup=false
fi
[[ $cleanup_value == true ]] && rm -rf -- "$out/.linux-acceptance"
cleanup_canonical; trap - EXIT
[[ ! -e $canonical && ! -L $canonical ]] || { echo 'Canonical Linux smoke prefix was not cleaned.' >&2; exit 1; }
[[ $smoke_status == 0 ]] || { echo 'Linux unpacked runtime smoke failed; inspect environment-acceptance.json.' >&2; exit 1; }
rm -rf -- "$payload"
node --input-type=module - "$out/environment-build.json" "$out/environment-acceptance.json" "$archive" "$out/environment-receipt.json" <<'JS'
import fs from 'node:fs';import {createHash} from 'node:crypto';
const [metaFile,acceptFile,packageFile,receiptFile]=process.argv.slice(2),meta=JSON.parse(fs.readFileSync(metaFile)),accept=JSON.parse(fs.readFileSync(acceptFile));
for(const key of ['target','version','commit','runId','nodeVersion'])if(accept[key]!==meta[key])throw Error('Linux acceptance metadata mismatch: '+key);
if(accept.ok!==true||accept.cleanupComplete!==true)throw Error('Linux runtime acceptance failed');
const hash=createHash('sha256').update(fs.readFileSync(packageFile)).digest('hex');
fs.writeFileSync(receiptFile,JSON.stringify({schemaVersion:1,target:meta.target,packageFile:packageFile.split(/[\\/]/).at(-1),packageSHA256:hash,acceptance:{passed:true,evidence:['environment-acceptance.json','chrome-sandbox.txt','loaded-libraries.json']}},null,2)+'\n');
JS
echo "$out.tar.gz"
