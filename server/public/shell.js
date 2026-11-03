const ids = ["purchase", "sales", "overview"],
  status = document.querySelector("#status"),
  message = document.querySelector("#message"),
  frame = document.querySelector("#workspace"),
  retry = document.querySelector("#retry");
let connected = false;
function select() {
  if (!connected) return;
  const id = ids.includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : "purchase";
  for (const a of document.querySelectorAll("nav a"))
    a.setAttribute("aria-current", a.hash === "#" + id ? "page" : "false");
  const next = "/apps/" + id + "/";
  if (frame.getAttribute("src") !== next) frame.src = next;
  frame.hidden = false;
  message.hidden = true;
}
async function connect() {
  try {
    const r = await fetch("/api/workbench/v1/session", { cache: "no-store" }),
      s = await r.json();
    if (!r.ok) throw Error(s.error || "连接失败");
    connected = true;
    status.textContent =
      s.actor.login === "local-development"
        ? "开发模式 · 隔离数据"
        : s.actor.label;
    retry.hidden = true;
    select();
  } catch (e) {
    connected = false;
    status.textContent = "连接不可用";
    message.textContent =
      e.message + "\n请检查主机服务和 Tailscale 连接，然后重试。";
    message.hidden = false;
    frame.hidden = true;
    retry.hidden = false;
  }
}
retry.addEventListener("click", connect);
window.addEventListener("hashchange", select);
window.addEventListener("offline", () => {
  status.textContent = "网络已断开，请核对未完成操作";
  retry.hidden = false;
});
window.addEventListener("online", connect);
void connect();
