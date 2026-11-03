import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const root = path.resolve(import.meta.dirname, "..");
const digest = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function verifyRelease(folder) {
  const m = JSON.parse(
    fs.readFileSync(path.join(folder, "web-release.json"), "utf8"),
  );
  if (
    m.schemaVersion !== 1 ||
    m.accepted !== true ||
    !Array.isArray(m.files) ||
    !m.files.length
  )
    throw Error("候选版本未验收");
  for (const item of m.files) {
    if (
      item.path.includes("\\") ||
      item.path.split("/").some((p) => !p || p === "." || p === "..") ||
      path.isAbsolute(item.path)
    )
      throw Error("版本清单路径无效");
    if (digest(path.join(folder, item.path)) !== item.sha256)
      throw Error("候选源码已变化：" + item.path);
  }
  return m;
}
function npm(folder, args) {
  const cli =
    process.env.npm_execpath ||
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: folder,
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.status !== 0) throw Error("npm 依赖准备失败：" + folder);
}
export async function prepareRelease(target, { install = true } = {}) {
  target = path.resolve(target);
  if (
    target === root ||
    target.startsWith(root + path.sep) ||
    fs.existsSync(target)
  )
    throw Error("版本必须使用源码目录以外的新目录");
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw Error("无法读取源码清单");
  const names = result.stdout
    .split("\0")
    .filter(Boolean)
    .filter(
      (n) =>
        /^(?:server\/|shared\/)/.test(n) ||
        /^apps\/(?:purchase|sales|overview)\/(?:server\.mjs$|package(?:-lock)?\.json$|workbench-manifest\.json$|lib\/|public\/)/.test(
          n,
        ),
    )
    .filter(
      (n) =>
        !/(?:^|\/)(?:node_modules|data|backups|logs)(?:\/|$)/.test(n) &&
        !/(?:\.sqlite(?:-|$)|\.log$|\.env|\.key$)/.test(n),
    );
  fs.mkdirSync(target, { recursive: true });
  for (const name of names) {
    const source = path.join(root, name);
    if (fs.lstatSync(source).isSymbolicLink()) throw Error("源码清单包含链接");
    const output = path.join(target, name);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(source, output);
  }
  const original = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const pkg = {
    name: "wucheng-erp-browser",
    version: original.version,
    private: true,
    type: "module",
    engines: { node: ">=24" },
    scripts: Object.fromEntries(
      Object.entries(original.scripts).filter(([k]) => k.startsWith("web:")),
    ),
    dependencies: Object.fromEntries(
      ["fastify", "@fastify/cookie", "@fastify/reply-from"].map((k) => [
        k,
        original.dependencies[k],
      ]),
    ),
  };
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  if (install) {
    npm(target, [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--omit=dev",
    ]);
    npm(target, ["ci", "--ignore-scripts", "--omit=dev"]);
    for (const id of ["purchase", "sales", "overview"])
      npm(path.join(target, "apps", id), [
        "ci",
        "--ignore-scripts",
        "--omit=dev",
      ]);
  }
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    accepted: false,
    files: [
      ...names,
      "package.json",
      ...(install ? ["package-lock.json"] : []),
    ].map((name) => ({ path: name, sha256: digest(path.join(target, name)) })),
  };
  fs.writeFileSync(
    path.join(target, "web-release.json"),
    JSON.stringify(manifest, null, 2),
  );
  if (install) {
    const run = spawnSync(process.execPath, ["server/acceptance.mjs"], {
      cwd: target,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180000,
    });
    if (run.status !== 0) throw Error("候选版本隔离验收失败：" + run.stderr);
    manifest.acceptance = JSON.parse(run.stdout.trim().split("\n").at(-1));
    manifest.accepted = manifest.acceptance.ok === true;
    fs.writeFileSync(
      path.join(target, "web-release.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
  return {
    ok: true,
    target,
    accepted: manifest.accepted,
    sourceFiles: manifest.files.length,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const target = process.argv[2];
  if (!target) throw Error("用法：node server/release.mjs <新版本目录>");
  prepareRelease(target)
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e.stack);
      process.exitCode = 1;
    });
}
