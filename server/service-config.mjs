import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { verifyRelease } from "./release.mjs";
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export function renderServiceXml({
  nodePath,
  bootstrapPath,
  configFile,
  stateDir,
}) {
  return `<service>\n <id>WuchengERPWeb</id>\n <name>五成 ERP 网页服务</name>\n <description>采购、销售、经营总览的私有网页服务</description>\n <executable>${xml(nodePath)}</executable>\n <arguments>&quot;${xml(bootstrapPath)}&quot; --config &quot;${xml(configFile)}&quot;</arguments>\n <stopexecutable>${xml(nodePath)}</stopexecutable>\n <stoparguments>&quot;${xml(bootstrapPath)}&quot; --config &quot;${xml(configFile)}&quot; --stop</stoparguments>\n <workingdirectory>${xml(stateDir)}</workingdirectory>\n <startmode>Automatic</startmode>\n <delayedAutoStart>true</delayedAutoStart>\n <stoptimeout>90 sec</stoptimeout>\n <onfailure action="restart" delay="10 sec"/>\n <logpath>${xml(path.join(stateDir, "logs"))}</logpath>\n <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>\n <hidewindow>true</hidewindow>\n</service>\n`;
}
export function prepareService(configFile, wrapper, output) {
  const c = loadConfig(configFile);
  if (c.mode !== "production") throw Error("Windows 服务只接受正式配置");
  verifyRelease(c.releaseRoot);
  if (!path.isAbsolute(wrapper) || !fs.existsSync(wrapper))
    throw Error("请指定已下载的官方 WinSW 可执行文件");
  fs.mkdirSync(output, { recursive: true });
  const bootstrap = path.join(output, "service-host.mjs"),
    xmlFile = path.join(output, "WuchengERPWeb.xml"),
    serviceExe = path.join(output, "WuchengERPWeb.exe");
  // WinSW 2 discovers XML next to an executable with the same basename.
  fs.copyFileSync(wrapper, serviceExe);
  fs.copyFileSync(
    path.join(import.meta.dirname, "service-host.mjs"),
    bootstrap,
  );
  fs.writeFileSync(
    xmlFile,
    renderServiceXml({
      nodePath: process.execPath,
      bootstrapPath: bootstrap,
      configFile: path.resolve(configFile),
      stateDir: c.stateDir,
    }),
  );
  c.windowsService = { wrapper: serviceExe, xml: xmlFile };
  fs.writeFileSync(configFile, JSON.stringify(c, null, 2));
  return {
    ok: true,
    xmlFile,
    installCommand: [serviceExe, "install"],
    startCommand: [serviceExe, "start"],
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [config, wrapper, output] = process.argv.slice(2);
  if (!config || !wrapper || !output)
    throw Error(
      "用法：node server/service-config.mjs <配置文件> <WinSW.exe> <服务配置目录>",
    );
  console.log(
    JSON.stringify(
      prepareService(config, wrapper, path.resolve(output)),
      null,
      2,
    ),
  );
}
