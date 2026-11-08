"""Real isolated payload regression. CI only; never run against a NAS app."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

assert os.geteuid() == 0 and os.environ.get("ERP_DIAG_STOP_CI") == "1"
cmd, work, output = map(Path, sys.argv[1:4])
results = []
for phase, starts in [("before-config", 0), ("after-first-start", 1)]:
    volume = work / ("stop-b" if starts == 0 else "stop-a")
    volume.mkdir()
    env = {**os.environ, "TRIM_APPDEST_VOL": str(volume), "ERP_DIAGNOSTIC_TEST_PAUSE": phase}
    base = volume / "@wuchengerpdiag-data"
    log = output / ("external-stop-" + phase + ".log")
    record = {"phase": phase, "ok": False}
    job = None
    run = None
    with log.open("w") as stream:
        try:
            job = subprocess.Popen(["/bin/sh", str(cmd / "acceptance"), "20"], env=env, stdout=stream, stderr=subprocess.STDOUT)
            end = time.monotonic() + 30
            while time.monotonic() < end:
                if (base / "active-run").exists():
                    run = base / (base / "active-run").read_text().strip()
                    file = run / "evidence/phase.json"
                    if file.exists() and json.loads(file.read_text())["phase"] == phase:
                        break
                assert job.poll() is None, "Acceptance exited before real checkpoint"
                time.sleep(0.05)
            else:
                raise AssertionError("Real diagnostic checkpoint not reached")
            snapshot = json.loads((run / "evidence/phase.json").read_text())
            record["unixSocketPathBytes"] = {name: len(str(run / "data/state" / name).encode()) for name in ["web.sock", "native.sock"]}
            assert max(record["unixSocketPathBytes"].values()) < 108, "CI Unix socket fixture path exceeds sun_path"
            assert (run / "data/config/web.json").exists() == (starts == 1)
            stopped = subprocess.run(["/bin/sh", str(cmd / "main"), "stop"], env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=55)
            assert stopped.returncode == 0, "External stop failed"
            time.sleep(0.2)
            assert job.poll() is not None, "EXTERNAL STOP RETURNED WHILE ACCEPTANCE STILL ACTIVE"
            assert job.returncode != 0, "Cancelled acceptance incorrectly reported success"
            report = json.loads((run / "evidence/acceptance.json").read_text())
            assert not report["ok"] and report.get("cancelReason") == "external-stop"
            assert report["successfulStarts"] == starts, "Service restarted after external stop"
            end = time.monotonic() + 3
            while subprocess.run(["pgrep", "-u", env["TRIM_USERNAME"]], stdout=subprocess.DEVNULL).returncode == 0 and time.monotonic() < end:
                time.sleep(0.05)
            assert subprocess.run(["pgrep", "-u", env["TRIM_USERNAME"]], stdout=subprocess.DEVNULL).returncode == 1, "Package clients/native children survived external stop"
            for port in [snapshot["fixturePort"], *range(29430, 29435), 29222, 29223, 29322, 29323]:
                with socket.socket() as client:
                    client.settimeout(0.2)
                    assert client.connect_ex(("127.0.0.1", port)) != 0, "Fixture/native listener survived stop: " + str(port)
            time.sleep(0.3)
            assert report["successfulStarts"] == starts and not (run / "data/state/native-supervisor.json").exists()
            record.update(ok=True, successfulStarts=starts, allPackageProcessesExited=True, fixtureAndNativeListenersClosed=True)
        except Exception as error:
            record["error"] = str(error)
        finally:
            if job is not None:
                try:
                    job.wait(timeout=70)  # Original bounded timeout/owned cleanup remains the backstop.
                except subprocess.TimeoutExpired:
                    record["cleanupError"] = "Acceptance exceeded its original timeout/cleanup budget"
            subprocess.run(["/bin/sh", str(cmd / "main"), "stop"], env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=85)
            if run and (run / "evidence").exists():
                shutil.copytree(run / "evidence", output / ("external-stop-" + phase + "-evidence"))
            if not record["ok"]:
                print(log.read_text(errors="replace")[-12000:], flush=True)
    results.append(record)
    (output / "diagnostic-external-stop.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(record), flush=True)
assert all(r["ok"] for r in results), "Real active diagnostic external-stop regression failed"
