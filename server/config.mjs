import fs from "node:fs";
import path from "node:path";
export const moduleIds = ["purchase", "sales", "overview"];
export const databases = {
  purchase: "purchases.sqlite",
  sales: "sales.sqlite",
  overview: "overview.sqlite",
};
const absolute = (value) => typeof value === "string" && path.isAbsolute(value);
export function developmentConfig({
  root = path.resolve(import.meta.dirname, ".."),
  stateDir = path.join(root, ".codex-artifacts", "web-dev"),
  port = 28430,
} = {}) {
  root = path.resolve(root);
  stateDir = path.resolve(stateDir);
  if (stateDir === root || !stateDir.includes(path.sep))
    throw Error("开发数据必须使用隔离目录");
  return validateConfig({
    schemaVersion: 1,
    mode: "development",
    host: "127.0.0.1",
    port,
    publicOrigin: `http://127.0.0.1:${port}`,
    stateDir,
    modules: Object.fromEntries(
      moduleIds.map((id, i) => [
        id,
        {
          root: path.join(root, "apps", id),
          dataDir: path.join(stateDir, "data", id),
          port: port + i + 1,
          ...(id === "purchase" ? { mobilePort: port + 4 } : {}),
        },
      ]),
    ),
  });
}
export function validateConfig(value) {
  const c = structuredClone(value);
  if (
    c.schemaVersion !== 1 ||
    !["development", "production"].includes(c.mode) ||
    c.host !== "127.0.0.1" ||
    !absolute(c.stateDir)
  )
    throw Error("网页服务配置无效");
  if (
    !c.modules ||
    Object.keys(c.modules).length !== 3 ||
    moduleIds.some((id) => !c.modules[id])
  )
    throw Error("网页服务只允许三个业务台");
  const origin = new URL(c.publicOrigin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (c.mode === "production"
      ? origin.protocol !== "https:"
      : origin.origin !== `http://127.0.0.1:${c.port}`)
  )
    throw Error("正式入口必须使用 HTTPS；开发入口必须使用本机隔离地址");
  c.publicOrigin = origin.origin;
  const ports = [c.port];
  for (const id of moduleIds) {
    const m = c.modules[id];
    if (!absolute(m.root) || !absolute(m.dataDir))
      throw Error("模块和账本必须使用完整路径");
    if (
      c.mode === "development" &&
      !path.resolve(m.dataDir).startsWith(path.resolve(c.stateDir) + path.sep)
    )
      throw Error("开发账本必须位于隔离目录");
    if (
      c.mode === "production" &&
      !fs.existsSync(path.join(m.dataDir, databases[id]))
    )
      throw Error(id + " 原账本不存在，已阻止创建空账本");
    ports.push(m.port);
    if (id === "purchase") ports.push(m.mobilePort);
  }
  if (
    ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535) ||
    new Set(ports).size !== ports.length
  )
    throw Error("服务端口无效或重复");
  if (
    new Set(
      moduleIds.map((id) => path.resolve(c.modules[id].dataDir).toLowerCase()),
    ).size !== 3
  )
    throw Error("三个账本目录不能相同");
  if (
    c.mode === "production" &&
    (!absolute(c.releaseRoot) ||
      moduleIds.some(
        (id) =>
          path.resolve(c.modules[id].root) !==
          path.resolve(c.releaseRoot, "apps", id),
      ))
  )
    throw Error("正式服务必须绑定独立版本目录 releaseRoot");
  if (c.dataVersion !== undefined) {
    const v=c.dataVersion;
    if(!v||typeof v!=='object'||typeof v.enabled!=='boolean')throw Error('数据版本配置无效');
    if(v.enabled){
      const within=(child,parent)=>path.resolve(child)===path.resolve(parent)||path.resolve(child).startsWith(path.resolve(parent)+path.sep);
      if(!absolute(v.dir)||!absolute(v.workspace)||!absolute(v.cmPath)||typeof v.repository!=='string'||!v.repository.includes('@')||/[\r\n]/.test(v.repository))throw Error('数据版本需要完整的独立路径与仓库规格');
      v.uploadMode??='host';
      if(!['host','user-agent'].includes(v.uploadMode))throw Error('数据版本上传模式无效');
      if(v.localHistoryCount!==undefined&&(!Number.isInteger(v.localHistoryCount)||v.localHistoryCount<1||v.localHistoryCount>1000))throw Error('数据版本本地保留数量必须为1至1000');
      if(c.mode==='development'&&!within(v.dir,c.stateDir))throw Error('开发数据版本必须位于隔离目录');
      if(!within(v.workspace,v.dir)||path.resolve(v.workspace)===path.resolve(v.dir))throw Error('数据版本工作区必须位于独立版本目录内');
      if(moduleIds.some(id=>within(v.dir,c.modules[id].dataDir)||within(c.modules[id].dataDir,v.dir)))throw Error('数据版本目录不能包含或位于正式数据目录');
    }
  }
  return c;
}
export function loadConfig(file) {
  if (!file || !fs.existsSync(file))
    throw Error("请显式指定网页服务配置文件，不会自动连接正式账本");
  return validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}
