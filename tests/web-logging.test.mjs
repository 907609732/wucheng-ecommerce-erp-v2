import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, silentLogger } from "../server/log.mjs";
import { createWorkbenchGateway } from "../server/gateway/gateway.mjs";

function capture(lines) {
  const logger = {
    level: "debug",
    file: null,
    scope: "test",
    enabled: () => true,
    debug: (message, data) => lines.push({ level: "debug", message, data }),
    info: (message, data) => lines.push({ level: "info", message, data }),
    warn: (message, data) => lines.push({ level: "warn", message, data }),
    error: (message, data) => lines.push({ level: "error", message, data }),
    child: () => logger,
    close() {},
  };
  return logger;
}

test("日志为单行格式，带作用域、级别和结构化字段", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-log-"));
  const file = path.join(dir, "nested", "web.log");
  const logger = createLogger({ level: "debug", file, mirror: false, scope: "host" });
  logger.info("模块已连接", { module: "sales", pid: 1234, ms: 12 });
  logger.warn("慢请求", { ms: 1600 });
  const child = logger.child("gateway");
  child.error("模块 purchase 未就绪：EPERM: rename\n  失败", { code: "EPERM" });
  logger.close();

  const text = fs.readFileSync(file, "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (DEBUG|INFO |WARN |ERROR) /);
  assert.match(lines[0], /INFO\s+host\s+模块已连接 \{"module":"sales","pid":1234,"ms":12\}/);
  assert.match(lines[1], /WARN\s+host\s+慢请求/);
  // 换行被压平，作用域可嵌套，原始错误码保留。
  assert.match(lines[2], /ERROR\s+host:gateway\s+模块 purchase 未就绪：EPERM: rename 失败 \{"code":"EPERM"\}/);
  assert.equal(text.split("\n").filter(Boolean).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("级别过滤与静默日志不产生输出", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-log-level-"));
  const file = path.join(dir, "web.log");
  const logger = createLogger({ level: "warn", file, mirror: false, scope: "host" });
  logger.debug("跳过", { a: 1 });
  logger.info("也跳过", { a: 2 });
  logger.warn("保留", { a: 3 });
  logger.close();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /WARN\s+host\s+保留/);
  assert.equal(silentLogger.enabled("error"), false);
  silentLogger.error("没有输出", { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("日志文件按大小轮转并保留历史", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-log-rotate-"));
  const file = path.join(dir, "web.log");
  const logger = createLogger({ level: "info", file, mirror: false, scope: "host", maxBytes: 400, keep: 2 });
  for (let index = 0; index < 60; index++) logger.info("第 " + index + " 条", { index });
  logger.close();
  assert.ok(fs.existsSync(file), "当前日志存在");
  assert.ok(fs.existsSync(file + ".1"), "轮转出的历史日志存在");
  const current = fs.statSync(file).size;
  assert.ok(current <= 1200, "当前日志不会无限增长：" + current);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("网关把业务台未就绪的真实原因写进日志，而不是只回 503", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gateway-log-"));
  const lines = [];
  const services = {
    config: () => ({ root: dir, dataDir: dir, version: "1.0.0" }),
    capabilities: async () => null,
    ensure: async () => {
      throw Object.assign(Error("EPERM: operation not permitted, rename 'web-ownership.json.tmp' -> 'web-ownership.json'"), { code: "EPERM" });
    },
  };
  const gateway = await createWorkbenchGateway({
    services,
    storeDir: path.join(dir, "gateway"),
    publicOrigin: "http://127.0.0.1:28430",
    localDevelopment: true,
    logger: capture(lines),
    port: 0,
  });
  t.after(async () => {
    await gateway.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const session = await gateway.app.inject({ url: "/api/workbench/v1/session", headers: { host: "127.0.0.1:28430" } });
  assert.equal(session.statusCode, 200, session.body);
  const cookie = [session.headers["set-cookie"]].flat()[0].split(";")[0];
  const response = await gateway.app.inject({ url: "/apps/purchase/", headers: { host: "127.0.0.1:28430", cookie } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "MODULE_UNAVAILABLE");

  const failure = lines.find((line) => line.level === "error" && line.message.includes("模块 purchase 未就绪"));
  assert.ok(failure, "必须记录 ensure 失败：" + JSON.stringify(lines));
  assert.match(failure.message, /EPERM/);
  assert.equal(failure.data.module, "purchase");
  assert.equal(failure.data.phase, "ensure");
  assert.ok(lines.some((line) => line.level === "error" && line.message.startsWith("GET /apps/purchase/") && line.data.status === 503), "必须记录请求结果");
});
