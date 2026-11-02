import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { getWorkbenchLocation } from "../desktop/shared/workbench-location.mjs";
import { moduleIds, databases } from "./config.mjs";
function size(dir) {
  let bytes = 0,
    files = 0;
  const visit = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) visit(f);
      else if (e.isFile()) {
        bytes += fs.statSync(f).size;
        files++;
      }
    }
  };
  visit(fs.existsSync(dir) ? fs.realpathSync(dir) : dir);
  return { bytes, files };
}
export function inspectEnvironment(root) {
  const git = spawnSync("git", ["status", "--short"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  const cm = spawnSync("cm", ["status", "--short"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  const report = {
    at: new Date().toISOString(),
    node: process.version,
    platform: os.platform(),
    git: { status: git.status, output: git.stdout },
    plastic: {
      status: cm.status,
      error: cm.error?.message || null,
      output: cm.stdout?.slice(0, 2000),
    },
    footprint: {},
    data: [],
    externalBackupVerified: false,
  };
  for (const rel of [
    "server",
    "apps/purchase/public",
    "apps/purchase/lib",
    "apps/sales/public",
    "apps/sales/lib",
    "apps/overview/public",
    "apps/overview/lib",
    "node_modules",
    "apps/purchase/node_modules",
    "apps/sales/node_modules",
    "apps/overview/node_modules",
    "dist",
    "tooling",
  ])
    report.footprint[rel] = size(path.join(root, rel));
  try {
    const location = getWorkbenchLocation();
    const registry = JSON.parse(fs.readFileSync(location.registryFile));
    report.location = location;
    for (const id of moduleIds) {
      const dir = registry[id]?.dataDir;
      if (!dir) continue;
      const file = path.join(dir, databases[id]);
      const b = path.join(dir, "backups");
      let tables = [];
      if (fs.existsSync(file)) {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          tables = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all()
            .filter((r) => /^[a-z_]+$/.test(r.name))
            .map((r) => ({
              table: r.name,
              rows: db.prepare("SELECT COUNT(*) AS n FROM " + r.name).get().n,
            }));
        } finally {
          db.close();
        }
      }
      report.data.push({
        id,
        dataDir: dir,
        databaseBytes: fs.existsSync(file) ? fs.statSync(file).size : null,
        tables,
        backupCount: fs.existsSync(b) ? fs.readdirSync(b).length : 0,
      });
    }
  } catch (e) {
    report.dataError = e.message;
  }
  return report;
}
