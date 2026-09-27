import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cainiao-desktop-smoke-"));
process.env.CAINIAO_APP_DATA_DIR = smokeRoot;
process.env.ERP_DATA_DIR = path.join(smokeRoot, "data");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
fs.copyFileSync(path.join(scriptDir, "..", "config.json"), path.join(smokeRoot, "config.json"));

const { rootDir } = await import("../core/config.js");
const { closeDb, getDb } = await import("../core/erp/db.js");
await import("../core/sync-cainiao-inventory.js");

if (rootDir !== smokeRoot) throw new Error("桌面数据目录未生效");
const result = getDb().prepare("SELECT 1 AS ok").get();
closeDb();
if (result.ok !== 1) throw new Error("SQLite 自检失败");

fs.rmSync(smokeRoot, { recursive: true, force: true });
console.log("PACKAGED_SMOKE_OK");
