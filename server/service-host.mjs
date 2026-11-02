import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const index = process.argv.indexOf("--config"),
  file = index < 0 ? null : process.argv[index + 1];
if (!file) throw Error("必须显式指定 --config");
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if (!path.isAbsolute(config.releaseRoot || ""))
  throw Error("正式配置缺少已验收版本目录 releaseRoot");
const { main } = await import(
  pathToFileURL(path.join(config.releaseRoot, "server", "cli.mjs")).href
);
await main([
  process.argv.includes("--stop") ? "shutdown" : "start",
  "--config",
  file,
]);
