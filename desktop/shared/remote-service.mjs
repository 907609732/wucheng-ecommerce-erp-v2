import Fastify from "fastify";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const TASK_TYPES = new Set(["sync", "monthly-sales", "monthly-backfill"]);

function accessIdentity(request) {
  return String(request.headers["cf-access-authenticated-user-email"] || "").trim().toLowerCase();
}

function assertLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(value)) throw new Error("远程服务只能监听本机回环地址");
  return value;
}

function normalizeOperatorEmails(value = []) {
  return new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean));
}

function monthlyFilters(query = {}) {
  return {
    year: String(query.year || ""),
    selectedMonth: String(query.selectedMonth || ""),
    scope: String(query.scope || "overall"),
    seriesMode: String(query.seriesMode || "top5"),
    sku: String(query.sku || "").trim()
  };
}
function taskPayload(body = {}) {
  const type = String(body.type || "").trim();
  if (!TASK_TYPES.has(type)) throw new Error("不支持的远程任务类型");
  if (type === "monthly-sales") return { type, options: { month: String(body.month || "") } };
  if (type === "monthly-backfill") {
    return { type, options: { from: String(body.from || ""), to: String(body.to || "") } };
  }
  return { type, options: {} };
}

export function createRemoteService(options = {}) {
  const host = assertLoopbackHost(options.host || "127.0.0.1");
  const port = Number(options.port || 17320);
  const requireAccessIdentity = options.requireAccessIdentity !== false;
  const operatorEmails = normalizeOperatorEmails(options.operatorEmails);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/v1/health") return;
    const email = accessIdentity(request);
    if (requireAccessIdentity && !email) {
      return reply.code(401).send({ ok: false, error: "需要通过 Cloudflare Access 登录" });
    }
    request.erpUserEmail = email;
  });

  app.get("/", async () => ({
    ok: true,
    service: "wucheng-ecommerce-erp-v2",
    message: "云仓库存同步远程服务已运行"
  }));

  app.get("/api/v1/health", async () => ({
    ok: true,
    mode: "server",
    time: new Date().toISOString(),
    ...(await options.getHealth?.())
  }));

  app.get("/api/v1/inventory", async () => ({ ok: true, data: await options.getInventory() }));
  app.get("/api/v1/monthly-sales", async (request) => ({
    ok: true,
    data: await options.getMonthlySales(monthlyFilters(request.query))
  }));
  app.get("/api/v1/task", async () => ({ ok: true, data: await options.getTaskState() }));

  app.post("/api/v1/jobs", async (request, reply) => {
    const email = accessIdentity(request);
    if (!email || !operatorEmails.has(email)) {
      return reply.code(403).send({ ok: false, error: "当前用户没有远程执行任务权限" });
    }
    let task;
    try {
      task = taskPayload(request.body);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error.message });
    }
    const result = await options.startTask(task.type, "remote", task.options, { requestedBy: email });
    return { ok: true, data: result };
  });

  app.post("/api/v1/jobs/stop", async (request, reply) => {
    const email = accessIdentity(request);
    if (!email || !operatorEmails.has(email)) {
      return reply.code(403).send({ ok: false, error: "当前用户没有远程停止任务权限" });
    }
    return { ok: true, data: await options.stopTask({ requestedBy: email }) };
  });

  return {
    get address() { return `http://${host}:${port}`; },
    async start() {
      await app.listen({ host, port });
      return `http://${host}:${port}`;
    },
    async stop() {
      await app.close();
    },
    app
  };
}
