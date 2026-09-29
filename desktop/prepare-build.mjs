import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const outputDir = path.resolve("build", "private");
const outputPath = path.join(outputDir, "update-token.txt");
const buildInfoPath = path.join(outputDir, "build-info.json");
const token = String(process.env.CAINIAO_INTERNAL_UPDATE_TOKEN || "").trim();
const allowMissingToken = process.argv.includes("--allow-missing-update-token");

if (!token && !allowMissingToken) {
  throw new Error(
    "缺少 CAINIAO_INTERNAL_UPDATE_TOKEN，已停止生成不可在线升级的安装包。" +
    "仅开发目录打包可使用 --allow-missing-update-token。"
  );
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
  channel: token ? "release" : "development"
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`内置更新凭据：${token ? "已注入" : "开发目录空占位"}`);
console.log(`构建信息：${commit.slice(0, 12) || "unknown"}`);
