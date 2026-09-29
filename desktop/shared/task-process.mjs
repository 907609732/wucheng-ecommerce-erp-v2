import { spawn } from "node:child_process";

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

export async function terminateProcessTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 5000
} = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null) {
    return { stopped: false, reason: "not-running" };
  }

  if (platform === "win32") {
    const killer = spawnProcess("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    killer.stderr?.setEncoding?.("utf8");
    killer.stderr?.on?.("data", (chunk) => { stderr += String(chunk); });
    const exitCode = await new Promise((resolve, reject) => {
      killer.once("error", reject);
      killer.once("close", (code) => resolve(code));
    });
    if (exitCode !== 0 && child.exitCode === null) {
      throw new Error(stderr.trim() || `taskkill 退出码 ${exitCode ?? "未知"}`);
    }
    return { stopped: true, forced: true };
  }

  child.kill("SIGTERM");
  if (!(await waitForClose(child, timeoutMs))) child.kill("SIGKILL");
  return { stopped: true, forced: child.exitCode === null };
}
