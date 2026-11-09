import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRelease } from "../../server/release.mjs";
import { buildMetadata } from "./metadata.mjs";

function copyTree(source, target, stack = new Set(), boundary = undefined) {
  const realSource = fs.realpathSync(source);
  boundary ??= realSource;
  if (stack.has(realSource))
    throw Error("拒绝复制循环目录链接：" + source);
  const nextStack = new Set(stack).add(realSource);
  fs.mkdirSync(target, { recursive: true });
  const relativeDirectory = path.relative(boundary, realSource).split(path.sep).join("/");
  const inDependencies = /(^|\/)node_modules(?:\/|$)/.test(relativeDirectory);
  for (const entry of fs.readdirSync(realSource, { withFileTypes: true })) {
    if (!inDependencies && ["data", "backups", "logs", "profiles", "browser-profile", ".cache"].includes(entry.name))
      throw Error("拒绝复制可能含运行数据或缓存的路径：" + entry.name);
    const from = path.join(realSource, entry.name), to = path.join(target, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(from);
      if (path.isAbsolute(link)) throw Error("拒绝绝对链接：" + from);
      const resolved = fs.realpathSync(from);
      if (resolved !== boundary && !resolved.startsWith(boundary + path.sep)) throw Error("拒绝树外链接：" + from);
      const linkedStat = fs.statSync(resolved);
      if (!linkedStat.isDirectory() && !linkedStat.isFile()) throw Error("拒绝特殊链接目标：" + from);
      fs.symlinkSync(link, to, linkedStat.isDirectory() ? "dir" : "file");
    }
    else if (stat.isDirectory()) copyTree(from, to, nextStack, boundary);
    else if (stat.isFile()) {
      if (/(^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-(?:wal|shm))?|key|p12|pfx)$/i.test(entry.name) || (entry.name.endsWith(".pem") && /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(fs.readFileSync(from, "utf8"))))
        throw Error("拒绝复制配置、账本或凭据文件：" + from);
      fs.copyFileSync(from, to);
    }
    else throw Error("拒绝复制特殊文件：" + from);
  }
}

function assertReleaseTree(releaseRoot) {
  const root = fs.realpathSync(releaseRoot);
  const manifest = verifyRelease(root);
  const listed = new Set(manifest.files.map((item) => item.path));
  const dependencyRoots = ["node_modules", ...["purchase", "sales", "overview"].map((id) => `apps/${id}/node_modules`)];
  const isDependencyPath = (name) => dependencyRoots.some((base) => name === base || name.startsWith(base + "/"));
  const hasListedDescendant = (name) => [...listed].some((file) => file.startsWith(name + "/"));
  function walk(dir, relative = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        if (!isDependencyPath(rel)) throw Error("release 含未登记链接：" + rel);
        const target = fs.realpathSync(absolute);
        const targetRelative = path.relative(root, target).split(path.sep).join("/");
        if (!isDependencyPath(targetRelative)) throw Error("依赖链接目标不在允许的 node_modules 树内：" + rel);
        continue;
      }
      if (stat.isDirectory()) {
        if (!isDependencyPath(rel) && !hasListedDescendant(rel)) throw Error("release 含未登记目录：" + rel);
        walk(absolute, rel);
        continue;
      }
      if (!stat.isFile()) throw Error("release 含特殊文件：" + rel);
      if (listed.has(rel) || rel === "web-release.json" || rel === "package-lock.json" || isDependencyPath(rel)) continue;
      throw Error("release 含未登记文件：" + rel);
    }
  }
  walk(root);
}

export function packageEnvironment({ target, releaseRoot, runtimeRoot, outputRoot, commit, runId, nodeVersion = "24.22.2" }) {
  if (!["windows-x64", "linux-x64"].includes(target)) throw Error("CLI 仅支持 windows-x64 或 linux-x64");
  releaseRoot = path.resolve(releaseRoot);
  runtimeRoot = path.resolve(runtimeRoot);
  outputRoot = path.resolve(outputRoot);
  assertReleaseTree(releaseRoot);
  if (!fs.statSync(runtimeRoot).isDirectory()) throw Error("runtime 必须为目录");
  const node = target === "windows-x64" ? path.join(runtimeRoot, "node", "node.exe") : path.join(runtimeRoot, "node", "bin", "node");
  if (!fs.existsSync(node)) throw Error("runtime 缺少目标平台 Node：" + node);
  const root = path.parse(outputRoot).root;
  const outputParent = path.dirname(outputRoot);
  if (!fs.existsSync(outputParent)) throw Error("输出父目录必须已存在");
  const realOutput = path.join(fs.realpathSync(outputParent), path.basename(outputRoot));
  const realRelease = fs.realpathSync(releaseRoot), realRuntime = fs.realpathSync(runtimeRoot);
  if (realOutput === root || realOutput === realRelease || realOutput.startsWith(realRelease + path.sep) || realOutput === realRuntime || realOutput.startsWith(realRuntime + path.sep) || realRelease.startsWith(realOutput + path.sep) || realRuntime.startsWith(realOutput + path.sep))
    throw Error("输出必须位于源码与 runtime 之外的新目录");
  if (fs.existsSync(outputRoot)) throw Error("输出目录必须是新目录");
  fs.mkdirSync(outputRoot, { recursive: false });
  try {
    copyTree(releaseRoot, path.join(outputRoot, "erp"));
    copyTree(runtimeRoot, path.join(outputRoot, "runtime"));
    const templateRoot = path.join(import.meta.dirname, "templates", target);
    if (!fs.existsSync(templateRoot)) throw Error("缺少平台模板：" + target);
    copyTree(templateRoot, outputRoot);
    const metadata = buildMetadata({ releaseRoot, target, commit, runId, nodeVersion });
    fs.writeFileSync(path.join(outputRoot, "environment-build.json"), JSON.stringify(metadata, null, 2) + "\n");
    return metadata;
  } catch (error) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function cli(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined) throw Error("参数必须为 --name value");
    options[args[i].slice(2)] = args[i + 1];
  }
  for (const key of ["target", "release", "runtime", "output", "commit", "run"])
    if (!options[key]) throw Error("缺少 --" + key);
  return packageEnvironment({ target: options.target, releaseRoot: options.release, runtimeRoot: options.runtime, outputRoot: options.output, commit: options.commit, runId: options.run });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(cli(process.argv.slice(2)))); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
