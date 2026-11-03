import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { signWorkbenchActor } from "./gateway/actor.mjs";
import { moduleIds } from "./config.mjs";
export async function verifyServices(services) {
  const caps = await Promise.all(moduleIds.map((id) => services.ensure(id))),
    result = [];
  const year = new Date().getFullYear(),
    period = String(year) + "-01";
  for (const [index, id] of moduleIds.entries()) {
    const cap = caps[index],
      config = services.config(id);
    const dataSetId = cap?.dataSetId || cap?.workbench?.dataSetId;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(dataSetId || ""))
      throw Error(id + " 账本身份检查失败");
    const key = fs
      .readFileSync(path.join(config.dataDir, ".workbench-key"), "utf8")
      .trim();
    for (const target of [
      "/api/bootstrap",
      id === "purchase"
        ? "/api/dashboard?year=" + year
        : id === "sales"
          ? "/api/report?grain=month&period=" + period
          : "/api/dashboard?grain=month&period=" + period,
    ]) {
      const now = Date.now(),
        headers = signWorkbenchActor(
          {
            v: 1,
            id: "service:readiness",
            login: "service-readiness",
            role: "admin",
            modules: moduleIds,
            canRunTasks: false,
            module: id,
            channel: "cli",
            sessionId: "readiness-" + randomUUID(),
            requestId: randomUUID(),
            issuedAt: now,
            expiresAt: now + 30000,
            method: "GET",
            path: target,
          },
          key,
        );
      const r = await fetch(cap.url + target, {
        headers,
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw Error(id + " 业务只读检查失败：" + r.status);
      }
      await r.json();
    }
    result.push({ id, dataSetId, ready: true });
  }
  return { ok: true, modules: result };
}
