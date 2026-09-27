import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = process.env.CAINIAO_APP_DATA_DIR
  ? path.resolve(process.env.CAINIAO_APP_DATA_DIR)
  : path.resolve(__dirname, "..");
const stateDir = path.join(rootDir, "state");
const lastKnownGoodConfigPath = path.join(stateDir, "config.last-known-good.json");

dotenv.config({ path: path.join(rootDir, ".env.local") });
dotenv.config({ path: path.join(rootDir, ".env") });

export function loadConfig() {
  const configPath = path.join(rootDir, "config.json");
  let config;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    config = JSON.parse(raw);
    fs.mkdirSync(stateDir, { recursive: true });
    if (!fs.existsSync(lastKnownGoodConfigPath) || fs.readFileSync(lastKnownGoodConfigPath, "utf8") !== raw) {
      fs.writeFileSync(lastKnownGoodConfigPath, raw, "utf8");
    }
  } catch (primaryError) {
    if (!fs.existsSync(lastKnownGoodConfigPath)) {
      throw new Error(`config.json 无法解析，且没有可用备份：${primaryError.message}`);
    }
    try {
      config = JSON.parse(fs.readFileSync(lastKnownGoodConfigPath, "utf8"));
      console.warn("⚠️ config.json 无法解析，已使用 state/config.last-known-good.json 继续运行");
    } catch (backupError) {
      throw new Error(`config.json 及最后可用备份均无法解析：${backupError.message}`);
    }
  }
  return {
    ...config,
    downloadDir: path.resolve(rootDir, config.downloadDir || "downloads"),
    reportDir: path.resolve(rootDir, config.reportDir || "reports"),
    stateDir
  };
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请在 .env.local 或 .env 中填写。`);
  }
  return value;
}
