import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { developmentConfig, moduleIds } from "./config.mjs";
import { createWebRuntime } from "./runtime.mjs";
async function freePorts() {
  for (let p = 34000; p < 50000; p += 5) {
    const sockets = [];
    try {
      for (let n = 0; n < 5; n++) {
        const s = net.createServer();
        sockets.push(s);
        await new Promise((r, j) =>
          s.once("error", j).listen(p + n, "127.0.0.1", r),
        );
      }
      return p;
    } catch {
    } finally {
      await Promise.all(sockets.map((s) => new Promise((r) => s.close(r))));
    }
  }
  throw Error("没有可用测试端口");
}
export async function acceptSource(root, { dataRoot, keepData = false } = {}) {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "wucheng-web-acceptance-"),
  );
  const config = developmentConfig({ root, stateDir, port: await freePorts() });
  if (dataRoot)
    for (const id of moduleIds) {
      const target = config.modules[id].dataDir;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(dataRoot, id), target, { recursive: true });
    }
  if (dataRoot && fs.existsSync(path.join(dataRoot, 'month-admin')))
    fs.cpSync(path.join(dataRoot, 'month-admin'), path.join(stateDir, 'month-admin'), {recursive:true});
  const start = performance.now(),
    runtime = await createWebRuntime(config, { watch: false });
  const result = {
    scope: dataRoot ? "isolated-business-copy" : "synthetic-local",
    remoteAcceptance: false,
    platformCollection: false,
    node: process.version,
    services: [],
  };
  try {
    await runtime.start();
    result.gatewayStartMs = performance.now() - start;
    const headers = { host: new URL(config.publicOrigin).host };
    const session = await runtime.gateway.app.inject({
      url: "/api/workbench/v1/session",
      headers,
    });
    if (session.statusCode !== 200) throw Error(session.body);
    headers.cookie = session.headers["set-cookie"].split(";")[0];
    for (const id of moduleIds) {
      const begin = performance.now();
      const page = await runtime.gateway.app.inject({
        url: "/apps/" + id + "/",
        headers,
      });
      if (page.statusCode !== 200) throw Error(page.body);
      const startupMs = performance.now() - begin;
      const times = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const response = await runtime.gateway.app.inject({
          url: "/apps/" + id + "/api/bootstrap",
          headers,
        });
        if (response.statusCode !== 200) throw Error(response.body);
        times.push(performance.now() - t);
      }
      const query =
        id === "purchase"
          ? "/api/dashboard?year=2026"
          : id === "sales"
            ? "/api/report?grain=month&period=2026-10"
            : "/api/dashboard?grain=year&period=2026";
      const queryMs = [];
      let queryDigest;
      for (let n = 0; n < 5; n++) {
        const t = performance.now(),
          r = await runtime.gateway.app.inject({
            url: "/apps/" + id + query,
            headers,
          });
        if (r.statusCode !== 200) throw Error(r.body);
        queryMs.push(performance.now() - t);
        queryDigest = createHash("sha256")
          .update(
            JSON.stringify(r.json(), (key, value) =>
              key === "generatedAt" ? undefined : value,
            ),
          )
          .digest("hex");
      }
      const cap = await runtime.services.capabilities(id);
      result.services.push({
        id,
        startAndPageMs: startupMs,
        bootstrapMs: times,
        queryMs,
        queryDigest,
        pid: cap.pid,
        sourceRoot: cap.root,
      });
    }
    result.hostRssBytes = process.memoryUsage().rss;
    if (process.platform === "win32") {
      const ids = result.services.map((s) => s.pid).join(",");
      const m = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-Process -Id " +
            ids +
            " | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      if (m.status === 0) result.moduleMemory = JSON.parse(m.stdout);
    }
    if (keepData) result.dataCopy = path.join(stateDir, "data");
    result.ok = true;
    return result;
  } finally {
    await runtime.stop();
    if (keepData && fs.existsSync(path.join(stateDir, 'month-admin')))
      fs.cpSync(path.join(stateDir, 'month-admin'), path.join(stateDir, 'data', 'month-admin'), {recursive:true});
    if (!keepData) fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  acceptSource(path.resolve(import.meta.dirname, ".."), {
    dataRoot: process.env.ERP_ACCEPTANCE_DATA_COPY,
  })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e.stack);
      process.exitCode = 1;
    });
}
