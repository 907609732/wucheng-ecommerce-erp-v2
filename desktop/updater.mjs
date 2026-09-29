import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

export function createUpdater({ app, getToken, onState, log }) {
  let state = {
    currentVersion: app.getVersion(),
    availableVersion: "",
    credentialAvailable: app.isPackaged ? null : false,
    status: app.isPackaged ? "idle" : "development",
    message: app.isPackaged ? "尚未检查" : "开发模式不检查更新"
  };

  const updateState = (patch) => {
    state = { ...state, ...patch };
    onState(state);
    return state;
  };
  const safeError = (error) => String(error?.message || error || "未知错误")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED]");

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => updateState({ status: "checking", message: "正在检查更新…" }));
  autoUpdater.on("update-available", (info) => {
    log(`发现新版本 ${info.version}，开始后台下载。`);
    updateState({ status: "downloading", availableVersion: info.version, message: `正在下载 ${info.version}` });
  });
  autoUpdater.on("download-progress", (progress) => updateState({
    status: "downloading",
    message: `正在下载 ${Math.round(progress.percent || 0)}%`
  }));
  autoUpdater.on("update-not-available", (info) => updateState({
    status: "current", availableVersion: info?.version || "", message: "已是最新版本"
  }));
  autoUpdater.on("update-downloaded", (info) => {
    log(`新版本 ${info.version} 已下载，等待安装。`, "success");
    updateState({ status: "ready", availableVersion: info.version, message: `版本 ${info.version} 已就绪` });
  });
  autoUpdater.on("error", (error) => {
    const message = safeError(error);
    log(`在线更新失败：${message}`, "error");
    updateState({ status: "error", message });
  });

  async function check({ automatic = false } = {}) {
    if (!app.isPackaged) return updateState({ credentialAvailable: false, status: "development", message: "开发模式不检查更新" });
    const token = String((await getToken()) || process.env.GH_TOKEN || "").trim();
    if (!token) {
      const result = updateState({ credentialAvailable: false, status: "needs-token", message: "当前安装包未配置在线更新凭据，请安装正式发布版" });
      if (!automatic) throw new Error(result.message);
      return result;
    }
    updateState({ credentialAvailable: true });
    process.env.GH_TOKEN = token;
    autoUpdater.requestHeaders = { Authorization: `token ${token}` };
    await autoUpdater.checkForUpdates();
    return state;
  }

  function initialize() {
    if (app.isPackaged) {
      void getToken()
        .then((token) => updateState({ credentialAvailable: Boolean(String(token || process.env.GH_TOKEN || "").trim()) }))
        .catch(() => updateState({ credentialAvailable: false }));
      setTimeout(() => check({ automatic: true }).catch(() => {}), 12_000);
    }
    return state;
  }

  function install() {
    if (state.status !== "ready") throw new Error("尚无已下载的更新");
    autoUpdater.quitAndInstall(false, true);
    return { installing: true };
  }

  return { check, getState: () => state, initialize, install };
}
