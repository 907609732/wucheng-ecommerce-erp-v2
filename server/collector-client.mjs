import fs from "node:fs";
import path from "node:path";
const unavailable = () => ({
  status: "needs-user-session",
  account: "",
  authorizationSaved: false,
  message:
    process.platform==='linux'?"菜鸟浏览器暂不可用，请稍后重连；已保存的账单文件保留。":"请在主机已登录的 Windows 用户会话启动 web:collector，并保持 Chrome 开启；账本服务仍可正常使用。",
});
export class CollectorBrowser {
  constructor(dataDir) {
    this.dir = path.join(dataDir, ".cainiao-staging");
    this.file = path.join(dataDir, ".web-collector.json");
    this.lease=null;
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
  async call(action, args = {}, timeout = 90000, signal, lease=this.lease) {
    let r;
    try {
      r = this.info();
    } catch {
      throw Object.assign(Error(unavailable().message), { status: 409 });
    }
    const budget=r.state?.mode==='native-shared'?Math.min(timeout+660000,1320000):Math.min(timeout+1000,661000);
    const response = await fetch(r.url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + r.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, args,deadline:Date.now()+budget,lease }),
      signal: signal?AbortSignal.any([signal,AbortSignal.timeout(budget+1000)]):AbortSignal.timeout(budget+1000),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error || "主机采集助手不可用"),{code:result.code});
    return result.result;
  }
  connect() {
    this.lease=null;
    return this.call("connect", {}, 660000);
  }
  async acquireSubmission({key,account,recovering=false,signal}={}) {
    if(this.info().state?.mode!=='native-shared')return async()=>{};
    this.lease=null;
    this.lease=await this.call('acquireSubmission',{key,account,recovering},1000,signal);
    const token=this.lease;
    let released=false;
    return async({unresolved=false}={})=>{if(released)return;released=true;try{await this.call('releaseSubmission',{unresolved},1000,undefined,token);}finally{if(this.lease===token)this.lease=null;}};
  }
  async settleSubmission(args){
    if(this.info().state?.mode==='native-shared')return this.call('settleSubmission',args,1000,undefined,null);
  }
  disconnect() {
    try {
      this.info();
    } catch {
      return Promise.resolve();
    }
    return this.call("disconnect").finally(()=>{this.lease=null;});
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
