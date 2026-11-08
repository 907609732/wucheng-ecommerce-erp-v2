"""CI-only root/UID regression for trusted diagnostic hooks, without a runtime.

The tiny executable fixture proves privilege and file ownership only. The real
packaged Node/Chromium lifecycle is tested separately by build-diagnostic.sh.
"""
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import tempfile

assert os.name == "posix" and os.geteuid() == 0
assert os.environ.get("ERP_DIAG_BOUNDARY_CI") == "1", "Only run on ephemeral CI"
repo = Path(__file__).resolve().parent.parent
user, uid = "erpdiagboundary", 23004
try:
    pwd.getpwnam(user)
except KeyError:
    subprocess.run(["useradd", "--no-create-home", "--uid", str(uid), user], check=True)
assert pwd.getpwnam(user).pw_uid == uid
root = Path(tempfile.mkdtemp(prefix="fnos-diagnostic-boundary-"))
root.chmod(0o755)
try:
    cmd = root / "cmd"
    shutil.copytree(repo / "deploy/fnos/diagnostic-cmd", cmd)
    for file in cmd.iterdir():
        file.chmod(0o755)
    target, volume = root / "target", root / "volume"
    node = target / "runtime/node/bin/node"
    node.parent.mkdir(parents=True)
    volume.mkdir()
    node.write_text("""#!/bin/sh
set -eu
[ "$(id -u)" = 23004 ] || exit 93
case "$1" in
 */lifecycle.mjs) exit 0;;
 */smoke-native.mjs)
  shift
  while [ "$#" -gt 0 ]; do
   case "$1" in --data-root) data=$2;; --evidence-dir) evidence=$2;; esac
   shift 2
  done
  mkdir -p "$data/config"
  printf '%s\\n' '{}' > "$data/config/web.json"
  printf '%s\\n' '{"ok":true,"fixtureOnly":true,"uid":23004}' > "$evidence/acceptance.json";;
 *) exit 94;;
esac
""", encoding="utf-8")
    node.chmod(0o755)
    base = volume / "@wuchengerpdiag-data"
    base.mkdir(mode=0o700)
    os.chown(base, uid, pwd.getpwnam(user).pw_gid)
    victim = root / "root-owned-victim"
    victim.write_bytes(b"ROOT SENTINEL MUST NOT CHANGE\n")
    victim.chmod(0o600)
    marker = base / "active-run"
    subprocess.run(["runuser", "-u", user, "--", "ln", "-s", str(victim), str(marker)], check=True)
    env = {**os.environ, "TRIM_APPDEST": str(target), "TRIM_APPDEST_VOL": str(volume), "TRIM_USERNAME": user, "TRIM_APPNAME": "wuchengerpdiag"}
    result = subprocess.run(["/bin/sh", str(cmd / "install_callback")], env=env, text=True, capture_output=True, timeout=20)
    assert victim.read_bytes() == b"ROOT SENTINEL MUST NOT CHANGE\n", "ROOT FOLLOWED PACKAGE-OWNED active-run SYMLINK"
    assert result.returncode != 0, "Malicious marker must fail closed"
    marker.unlink()
    result = subprocess.run(["/bin/sh", str(cmd / "install_callback")], env=env, text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    assert marker.stat().st_uid == uid
    run = base / marker.read_text().strip()
    report = json.loads((run / "evidence/acceptance.json").read_text())
    assert report["uid"] == uid and report["fixtureOnly"]
    for file in run.rglob("*"):
        assert file.stat().st_uid == uid, "Root wrote inside package-owned run: " + str(file)
    assert stat.S_IMODE(base.stat().st_mode) == 0o700
    print(json.dumps({"ok": True, "rootVictimUnchanged": True, "allRunFilesOwnedBy": uid, "scope": "CI hook privilege fixture, not runtime proof"}))
finally:
    shutil.rmtree(root)
    subprocess.run(["userdel", user], check=True)
