import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const outputDir = path.resolve("build", "private");
const outputPath = path.join(outputDir, "update-token.txt");
const buildInfoPath = path.join(outputDir, "build-info.json");
const token = String(process.env.CAINIAO_INTERNAL_UPDATE_TOKEN || "").trim();
const requestedChannel = String(
  process.argv.find((value) => value.startsWith("--channel="))?.slice("--channel=".length)
  || process.env.CAINIAO_BUILD_CHANNEL
  || "development"
).trim().toLowerCase();
const supportedChannels = new Set(["release", "beta", "test", "development"]);

if (!supportedChannels.has(requestedChannel)) {
  throw new Error(`不支持的构建渠道：${requestedChannel}`);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, token, { encoding: "utf8", mode: 0o600 });
let commit = String(process.env.GITHUB_SHA || "").trim();
if (!commit) {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    commit = "unknown";
  }
}
fs.writeFileSync(buildInfoPath, `${JSON.stringify({
  commit,
  builtAt: new Date().toISOString(),
  channel: requestedChannel
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`内置更新凭据：${token ? "已注入（兼容旧安装包）" : "公开 GitHub 发布无需凭据"}`);
console.log(`构建渠道：${requestedChannel}`);
console.log(`构建信息：${commit.slice(0, 12) || "unknown"}`);
