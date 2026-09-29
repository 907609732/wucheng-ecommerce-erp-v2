import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const outputDir = path.resolve("build", "private");
const outputPath = path.join(outputDir, "update-token.txt");
const buildInfoPath = path.join(outputDir, "build-info.json");
const token = String(process.env.CAINIAO_INTERNAL_UPDATE_TOKEN || "").trim();
const allowMissingToken = process.argv.includes("--allow-missing-update-token");
const requestedChannel = String(
  process.argv.find((value) => value.startsWith("--channel="))?.slice("--channel=".length)
  || process.env.CAINIAO_BUILD_CHANNEL
  || (token ? "release" : "development")
).trim().toLowerCase();
const supportedChannels = new Set(["release", "beta", "test", "development"]);

if (!supportedChannels.has(requestedChannel)) {
  throw new Error(`不支持的构建渠道：${requestedChannel}`);
}

if (requestedChannel === "release" && !token) {
  throw new Error(
    "缺少 CAINIAO_INTERNAL_UPDATE_TOKEN，已停止生成不可在线升级的安装包。" +
    "正式版必须注入更新凭据。"
  );
}
if (!token && !allowMissingToken) {
  throw new Error("缺少 CAINIAO_INTERNAL_UPDATE_TOKEN；非正式构建需显式添加 --allow-missing-update-token。");
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
console.log(`内置更新凭据：${token ? "已注入" : "开发目录空占位"}`);
console.log(`构建渠道：${requestedChannel}`);
console.log(`构建信息：${commit.slice(0, 12) || "unknown"}`);
