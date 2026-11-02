import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { moduleIds, databases } from "./config.mjs";
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const excluded = (name) =>
  [
    "backups",
    "recovered",
    "restored",
    "staging",
    ".web-collector.json",
    ".cainiao-staging",
  ].includes(name) ||
  /\.log$|\.sqlite-(?:wal|shm)$|\.lock$|^\.integration-runtime|^\.workbench-maintenance/.test(
    name,
  );
function files(dir, prefix = "") {
  const result = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded(e.name)) continue;
    const rel = prefix ? prefix + "/" + e.name : e.name,
      file = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw Error("备份不允许重定向路径");
    if (e.isDirectory()) result.push(...files(file, rel));
    else if (e.isFile()) result.push({ file, rel });
  }
  return result;
}
function stopped(dataDir) {
  const file = path.join(dataDir, ".integration-runtime.json");
  if (!fs.existsSync(file)) return;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(record.pid)) throw Error("模块运行记录无效");
  try {
    process.kill(record.pid, 0);
  } catch (e) {
    if (e.code === "ESRCH") return;
    throw e;
  }
  throw Error("模块仍在运行，请先进入维护并停止服务再备份");
}
export async function snapshotData(config, target) {
  target = path.resolve(target);
  if (fs.existsSync(target)) throw Error("备份目录已存在");
  for (const id of moduleIds) {
    const dir = path.resolve(config.modules[id].dataDir);
    if (target === dir || target.startsWith(dir + path.sep))
      throw Error("备份不能写入源账本目录");
    stopped(dir);
    if (!fs.existsSync(path.join(dir, databases[id])))
      throw Error("原账本缺失");
  }
  fs.mkdirSync(target, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    files: [],
  };
  try {
    for (const id of moduleIds)
      for (const { file, rel } of files(config.modules[id].dataDir)) {
        const output = path.join(target, id, rel);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        if (file.endsWith(".sqlite")) {
          const db = new DatabaseSync(file, { readOnly: true });
          try {
            await backup(db, output);
          } finally {
            db.close();
          }
        } else fs.copyFileSync(file, output);
        manifest.files.push({
          path: id + "/" + rel,
          bytes: fs.statSync(output).size,
          sha256: hash(output),
        });
      }
    fs.writeFileSync(
      path.join(target, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    verifySnapshot(target);
    return { ok: true, target, files: manifest.files.length };
  } catch (e) {
    fs.writeFileSync(path.join(target, "FAILED.txt"), e.message);
    throw e;
  }
}
export function verifySnapshot(target) {
  const m = JSON.parse(
    fs.readFileSync(path.join(target, "manifest.json"), "utf8"),
  );
  if (m.schemaVersion !== 1 || !Array.isArray(m.files) || !m.files.length)
    throw Error("备份校验清单无效");
  const seen = new Set();
  for (const r of m.files) {
    if (
      typeof r.path !== "string" ||
      !moduleIds.includes(r.path.split("/")[0]) ||
      r.path.includes("\\") ||
      r.path.split("/").some((p) => !p || p === "." || p === "..") ||
      seen.has(r.path)
    )
      throw Error("备份校验路径无效");
    seen.add(r.path);
    const file = path.join(target, r.path);
    let current = target;
    for (const part of r.path.split("/")) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink())
        throw Error("备份校验不允许重定向");
    }
    if (fs.statSync(file).size !== r.bytes || hash(file) !== r.sha256)
      throw Error("备份校验失败：" + r.path);
    if (file.endsWith(".sqlite")) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
          throw Error("账本校验失败");
      } finally {
        db.close();
      }
    }
  }
  for (const id of moduleIds)
    if (!seen.has(id + "/" + databases[id])) throw Error("备份校验缺少账本");
  return { ok: true, files: m.files.length };
}
export function restoreSnapshot(source, target) {
  verifySnapshot(source);
  if (fs.existsSync(target)) throw Error("恢复目录已存在，禁止覆盖");
  const m = JSON.parse(
    fs.readFileSync(path.join(source, "manifest.json"), "utf8"),
  );
  for (const r of m.files) {
    const file = path.join(target, r.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(source, r.path), file);
  }
  return { ok: true, target, files: m.files.length };
}
