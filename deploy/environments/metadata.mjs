import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { verifyRelease } from "../../server/release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const textFile = /\.(?:[cm]?js|json|html|css|md|txt|ya?ml|svg|ps1|psm1|psd1|bat|cmd|cs|sh|xml|csv|webmanifest)$/i;

export function sourceDigest(releaseRoot) {
  const release = path.resolve(releaseRoot);
  const manifest = verifyRelease(release);
  const records = manifest.files
    .filter(({ path: name }) => name !== "package-lock.json")
    .map(({ path: name }) => {
      const file = path.resolve(release, name);
      if (!file.startsWith(release + path.sep)) throw Error("版本清单路径越界");
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error("版本清单包含非普通文件：" + name);
      const bytes = fs.readFileSync(file);
      const normalized = textFile.test(name)
        ? Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8")
        : bytes;
      return { path: name, sha256: hash(normalized) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return hash(Buffer.from(JSON.stringify(records)));
}

export function buildMetadata({ releaseRoot, target, commit, runId, nodeVersion }) {
  if (!["windows-x64", "linux-x64", "fnos-x64"].includes(target)) throw Error("目标平台无效");
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw Error("commit 必须为 40 位 SHA");
  if (!/^\d+$/.test(String(runId))) throw Error("runId 必须为十进制数字");
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion) || nodeVersion !== "24.22.2") throw Error("Node 版本必须固定为 24.22.2");
  const release = verifyRelease(path.resolve(releaseRoot));
  const version = JSON.parse(fs.readFileSync(path.join(releaseRoot, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("release version 无效");
  return {
    schemaVersion: 1,
    target,
    version,
    commit: commit.toLowerCase(),
    runId: String(runId),
    nodeVersion,
    commonSourceSHA256: sourceDigest(releaseRoot),
  };
}

export function verifyEnvironmentSource(releaseRoot, metadata) {
  const actual = sourceDigest(releaseRoot);
  if (actual !== metadata.commonSourceSHA256) throw Error("环境包 commonSourceSHA256 与已验收源码不符");
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action, releaseRoot, metadataPath] = process.argv.slice(2);
    if (action !== "--verify-source" || !releaseRoot || !metadataPath) throw Error("用法: node metadata.mjs --verify-source <releaseRoot> <environment-build.json>");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8").replace(/^\uFEFF/, ""));
    console.log(JSON.stringify({ commonSourceSHA256: verifyEnvironmentSource(releaseRoot, metadata) }));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
