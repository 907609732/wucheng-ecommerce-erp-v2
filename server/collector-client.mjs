import fs from "node:fs";
import path from "node:path";
const unavailable = () => ({
  status: "needs-user-session",
  account: "",
  authorizationSaved: false,
  message:
    "请在主机已登录的 Windows 用户会话启动 web:collector，并保持 Chrome 开启；账本服务仍可正常使用。",
});
export class CollectorBrowser {
  constructor(dataDir) {
    this.dir = path.join(dataDir, ".cainiao-staging");
    this.file = path.join(dataDir, ".web-collector.json");
  }
  info() {
    const r = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (
      r.schemaVersion !== 1 ||
      !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(r.url) ||
      !/^[a-f0-9]{64}$/.test(r.token) ||
      Date.now() - r.at > 6000 ||
      r.at > Date.now() + 5000
    )
      throw Error("采集助手未连接");
    return r;
  }
  status() {
    try {
      return this.info().state;
    } catch {
      return unavailable();
    }
  }
  async call(action, args = {}, timeout = 90000) {
    let r;
    try {
      r = this.info();
    } catch {
      throw Object.assign(Error(unavailable().message), { status: 409 });
    }
    const response = await fetch(r.url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + r.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, args }),
      signal: AbortSignal.timeout(Math.min(timeout + 1000, 661000)),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "主机采集助手不可用");
    return result.result;
  }
  connect() {
    return this.call("connect", {}, 660000);
  }
  disconnect() {
    try {
      this.info();
    } catch {
      return Promise.resolve();
    }
    return this.call("disconnect");
  }
  run(op, args = {}, timeout = 90000) {
    return this.call("run", { op, args, timeout }, timeout);
  }
  rememberAuthorization(token) {
    return this.call("rememberAuthorization", { token });
  }
  forgetAuthorization() {
    return this.call("forgetAuthorization");
  }
}
