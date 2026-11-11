const publicPrefix = (document.currentScript?.src || '').match(/^(?:https?:\/\/[^/]+)?(\/app\/wuchengerp(?:trial)?)\/web\//)?.[1] || '';
const ids = ["purchase", "sales", "freight", "overview", "data-versions"],
  status = document.querySelector("#status"),
  message = document.querySelector("#message"),
  frame = document.querySelector("#workspace"),
  retry = document.querySelector("#retry");
let connected = false;
let nativeBrowserEnabled=false;
let retryPage = false;
const hostingStatus = document.querySelector("#hosting-status");
let hostingTimer, hostingController, disposed = false;
async function refreshHosting() {
  clearTimeout(hostingTimer);
  if (!connected || document.hidden || disposed) return;
  hostingController?.abort();
  const controller = new AbortController();
  hostingController = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(publicPrefix+"/api/workbench/v1/data-versions/summary", { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw Error("托管状态查询失败");
    const summary = await response.json();
    if (hostingController !== controller || document.hidden || disposed) return;
    hostingStatus.hidden = !summary.enabled;
    hostingStatus.textContent = `待托管 ${Number(summary.pending || 0)} / 托管异常 ${Number(summary.failed || 0)}`;
    hostingStatus.classList.toggle("hosting-error", Number(summary.failed || 0) > 0);
    hostingStatus.title = "业务保存与云端托管独立进行，点击查看数据版本";
  } catch {
    if (hostingController !== controller || document.hidden || disposed) return;
    hostingStatus.hidden = false;
    hostingStatus.textContent = "托管状态待查询";
    hostingStatus.classList.add("hosting-error");
    hostingStatus.title = "托管状态查询失败，不代表业务保存失败，点击查看数据版本";
  } finally {
    clearTimeout(timeout);
    if (hostingController === controller && !document.hidden && !disposed && connected) hostingTimer = setTimeout(refreshHosting, 60000);
  }
}
function select() {
  if (!connected) return;
  retryPage = false;
  retry.hidden = true;
  const id = (ids.includes(location.hash.slice(1))||nativeBrowserEnabled&&location.hash.slice(1)==='native-browser')
    ? location.hash.slice(1)
    : "purchase";
  for (const a of document.querySelectorAll("nav a"))
    a.setAttribute("aria-current", a.hash === "#" + id ? "page" : "false");
  const next = publicPrefix + (id === "freight" ? "/apps/sales/?workspace=freight#freight?section=center" : id === "native-browser" ? "/web/native-browser.html" : id === "data-versions" ? "/web/data-versions.html" : "/apps/" + id + "/");
  frame.title = id === "data-versions" ? "数据版本" : "业务工作区";
  if (frame.getAttribute("src") !== next) frame.src = next;
  frame.hidden = false;
  message.hidden = true;
}
async function connect() {
  try {
    const r = await fetch(publicPrefix+"/api/workbench/v1/session", { cache: "no-store" }),
      s = await r.json();
    if (!r.ok) throw Error(s.error || "连接失败");
    connected = true;
    nativeBrowserEnabled=s.nativeBrowser?.enabled===true;
    const browserEntry=document.querySelector('#native-browser-entry');
    if(browserEntry)browserEntry.hidden=!nativeBrowserEnabled;
    status.textContent =
      s.actor.login === "local-development"
        ? "开发模式 · 隔离数据"
        : s.actor.label;
    retry.hidden = true;
    select();
    void refreshHosting();
  } catch (e) {
    connected = false;
    clearTimeout(hostingTimer);
    hostingController?.abort();
    status.textContent = "连接不可用";
    message.textContent =
      e.message + "\n请检查主机服务和 Tailscale 连接，然后重试。";
    message.hidden = false;
    frame.hidden = true;
    retry.hidden = false;
  }
}
frame.addEventListener("load", () => {
  if (!connected) return;
  try {
    const doc = frame.contentDocument;
    if (doc?.documentElement.dataset.businessStarted === "true" ||
        !doc?.querySelector("[data-business-startup]")) return;
    const failed = frame.contentWindow.performance
      .getEntriesByType("resource")
      .some((entry) => /\.m?js(?:\?|$)/.test(entry.name) &&
        typeof entry.responseStatus === "number" &&
        (entry.responseStatus === 0 || entry.responseStatus >= 400));
    if (!failed) return;
    retryPage = true;
    message.textContent = "页面资源加载失败，业务台尚未启动。请检查连接后点击重新连接重试。";
    message.hidden = false;
    frame.hidden = true;
    retry.hidden = false;
  } catch { /* Same-origin pages only; connection errors remain handled by connect. */ }
});
retry.addEventListener("click", () => {
  if (!retryPage) return void connect();
  retryPage = false;
  message.hidden = true;
  frame.hidden = false;
  retry.hidden = true;
  frame.contentWindow.location.reload();
});
window.addEventListener("hashchange", select);
window.addEventListener("offline", () => {
  status.textContent = "网络已断开，请核对未完成操作";
  retry.hidden = false;
});
window.addEventListener("online", connect);
document.addEventListener("visibilitychange", () => {
  clearTimeout(hostingTimer);
  if (document.hidden) hostingController?.abort();
  else void refreshHosting();
});
window.addEventListener("pagehide", () => { disposed = true; clearTimeout(hostingTimer); hostingController?.abort(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) { disposed = false; void refreshHosting(); } });
void connect();
