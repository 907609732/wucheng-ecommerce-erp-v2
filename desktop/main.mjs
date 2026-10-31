import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } from "electron";
import {readComponentContext} from "./shared/component-context.mjs";
import {installBundledDesks} from './shared/install-desks.mjs';
import {ServiceManager} from './shared/service-manager.mjs';
import {agentBetaPaths,guardAgentServices} from './agent-host/isolation.mjs';
import {startCloudControl} from './modules/cloud-control.mjs';
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SETTINGS,
  EDITABLE_SECRET_FIELDS,
  SECRET_FIELDS,
  nextMonthlyRunAt,
  nextRunAt,
  normalizeSettings,
  validateAutomationSettings,
  validateCainiaoSettings,
  validateDingTalkSettings,
  validateRuntimeSettings,
  validateSettings
} from "./shared/settings.mjs";
import { decryptedText } from "./shared/secret-storage.mjs";
import { parseCliRequest } from "./shared/ai-interface.mjs";
import { diagnosticHealth, redactDiagnosticValue, sanitizeDiagnosticText, searchDiagnosticLines } from "./shared/diagnostics.mjs";
import { createRuntimeCapabilities } from "./shared/runtime-contract.mjs";
import { discoverExtensions, invokeTrustedExtension, normalizeTrustedExtensionIds } from "./shared/extensions.mjs";
import { requestedUserDataPath } from "./shared/user-data-path.mjs";
import { getWorkbenchLocation } from "./shared/workbench-location.mjs";
import { readCainiaoInventory } from "./shared/inventory-store.mjs";
import {createWarehouseDaily,expectedInventoryDate} from '../core/erp/warehouse-daily.js';
import {normalizeReminderSettings,reminderChannelStates,createWarehouseReminderSenders} from './shared/warehouse-reminder-senders.mjs';
import { readMonthlySalesDashboard } from "./shared/monthly-sales-store.mjs";
import { createUpdater } from "./updater.mjs";
import { terminateProcessTree } from "./shared/task-process.mjs";
import { mergeScheduledTasks, queueAfterTaskResult } from "./shared/task-schedule.mjs";
import { externalLink } from "./shared/external-links.mjs";
import { CHANGELOG } from './shared/changelog.mjs';
import { defaultBackfillRange, latestCompleteMonth, shiftMonth } from "../core/erp/monthly-sales-dashboard.js";
import brandingModule from "./shared/branding.cjs";
import {createWarehouseAgentAdapter} from './workbench/warehouse-agent.mjs';

const { buildBranding } = brandingModule;
const componentContext = readComponentContext("warehouse");
const componentAppRoot = componentContext?.appRoot || app.getAppPath();
const componentResourcesDir = componentContext?.resourcesDir || process.resourcesPath;
const componentVersion = componentContext?.version || app.getVersion();
const componentLaunchArgs = componentContext?.launchArgs || [];
// Explicit opt-in from the isolated Agent host. Existing production scheduling
// remains unchanged until a separately approved migration switches ownership.
const agentManaged=process.env.LINGTU_AGENT_MANAGED==='1';
let warehouseAgent;

let startupLocation;
try {
  startupLocation = getWorkbenchLocation(app.getPath("appData"), {
    explicitProfile: requestedUserDataPath(process.argv), registryFile: process.env.LINGTU_REGISTRY_PATH
  });
} catch (error) {
  if (process.argv.includes("--cli") || process.argv.includes("--mcp-stdio")) {
    process.stderr.write("工作台数据位置需要核对：" + error.message + "\n");
  } else {
    await app.whenReady();
    dialog.showErrorBox("工作台数据位置需要核对", error.message);
  }
  process.exit(1);
}
const stableUserDataPath = startupLocation.profile;
if (!process.env.LINGTU_REGISTRY_PATH) process.env.LINGTU_REGISTRY_PATH = startupLocation.registryFile;
fs.mkdirSync(stableUserDataPath, { recursive: true });
app.setPath("userData", stableUserDataPath);
// Business files may move without changing Chromium's encrypted login profile.
if(process.env.LINGTU_AUTH_PROFILE_DIR){
  const authProfile=path.resolve(process.env.LINGTU_AUTH_PROFILE_DIR);
  if(!fs.existsSync(authProfile))throw Error('原认证目录不存在，已阻止初始化空登录环境');
  app.setPath('sessionData',authProfile);
}

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(desktopDir, "preload.cjs");
const rendererPath = path.join(desktopDir, "renderer", "index.html");
const cliArgumentIndex = process.argv.indexOf("--cli");
const cliMode = cliArgumentIndex >= 0;
const mcpMode = process.argv.includes("--mcp-stdio");
const headlessMode = cliMode || mcpMode;
const singleInstance = headlessMode || app.requestSingleInstanceLock();

if (!singleInstance) app.quit();

let mainWindow = null;
let runningChild = null;
let runningKind = "";
let scheduleTimer = null;
let nextScheduledRun = null;
let nextMonthlyScheduledRun = null;
let scheduledTaskQueue = [];
let recentLog = [];
let quitting = false;
let updater = null;
let runningTaskPromise = null;
let stopRequestedPid = null;
let mcpBridgeChild = null;
let cachedSettings = null;
let cachedSecrets = null;
let remoteService = null;
const managedCloud = process.env.LINGTU_MANAGED_MODULE === '1' || process.argv.includes('--managed-module=warehouse');
let managedMaintenance = managedCloud && process.env.LINGTU_MAINTENANCE === '1';
let cloudControl = null;
let warehouseDaily = null;
let reminderTimer = null;
let reminderWork = 0;
const localDailyActor={id:'local-admin',login:'local-admin',name:'本机管理员',role:'admin',local:true,channel:'ui'};
function dailyService() {
  if(!warehouseDaily)warehouseDaily=createWarehouseDaily({databasePath:inventoryDatabasePath(),senders:createWarehouseReminderSenders({readSettings,readSecrets}),getChannels:async()=>reminderChannelStates(readSettings().warehouseReminders,await readSecrets(),readSettings())});
  return warehouseDaily;
}
async function dailyStatus(actor=localDailyActor) {
  assertDailyAvailable();
  const value=await dailyService().status(actor);
  if(actor.local)value.reminderSettings={...normalizeReminderSettings(readSettings().warehouseReminders),secretFlags:Object.fromEntries(['smtpPassword','aliyunAccessKeyId','aliyunAccessKeySecret'].map(key=>[key,Boolean(cachedSecrets?.[key])]))};
  return value;
}
async function dailyRemind(actor,payload) {
  assertDailyAvailable();
  reminderWork++;
  try{return await dailyService().remind(actor,payload);}finally{reminderWork--;}
}
function assertDailyAvailable(){
  if(managedMaintenance||fs.existsSync(path.join(app.getPath('userData'),'.workbench-maintenance.json')))throw Error('云仓正在维护，请完成维护后再操作签到管理');
}

function appDataDir() {
  return path.join(app.getPath("userData"), "workspace");
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function secretsPath() {
  return path.join(app.getPath("userData"), "secrets.bin");
}

function inventoryDatabasePath() {
  return path.join(appDataDir(), "data", "erp.sqlite");
}

function runtimeMode() {
  // The managed warehouse is a host service. Network role and Tailscale
  // configuration belong to the outer workbench, not the module's old config.
  return managedCloud ? 'server' : readSettings().runtimeMode;
}

async function remoteRequest() {
  throw new Error('旧版远程连接已停用，请从工作台 Tailscale 入口打开云仓');
}

function notifyRemoteConnection(connected, message, health = null) {
  const payload = { connected: Boolean(connected), message: String(message || ""), health };
  mainWindow?.webContents.send("remote:connection", payload);
  return payload;
}

function bundledUpdateTokenPath() {
  return path.join(componentResourcesDir, "update-token.txt");
}

function buildInfoPath() {
  return path.join(componentResourcesDir, "build-info.json");
}

function logDir() {
  return path.join(appDataDir(), "logs");
}

function currentLogPath() {
  return path.join(logDir(), "desktop.log");
}

function desktopTaskLockPath() {
  return path.join(appDataDir(), "state", "desktop-task.lock");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readTaskLock() {
  try {
    return JSON.parse(fs.readFileSync(desktopTaskLockPath(), "utf8"));
  } catch {
    return null;
  }
}

function acquireTaskLock(kind) {
  const lockPath = desktopTaskLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const runId = randomUUID();
  const payload = { pid: process.pid, runId, kind, startedAt: new Date().toISOString() };
  const write = () => fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    write();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readTaskLock();
    if (isProcessAlive(Number(existing?.pid))) {
      throw new Error(`已有${existing?.kind === "login" ? "登录" : "同步"}任务正在运行`);
    }
    const archivePath = path.join(logDir(), `desktop-task.lock.stale-${Date.now()}.json`);
    fs.mkdirSync(logDir(), { recursive: true });
    fs.renameSync(lockPath, archivePath);
    write();
  }
  return () => {
    try {
      const current = readTaskLock();
      if (current?.runId === runId) fs.rmSync(lockPath);
    } catch {
      // A retained lock is safer than removing a lock owned by another process.
    }
  };
}

function ensureWorkspace() {
  const root = appDataDir();
  for (const dir of [
    root,
    path.join(root, "data"),
    path.join(root, "downloads"),
    path.join(root, "reports"),
    path.join(root, "state"),
    path.join(root, "tests", ".auth"),
    path.join(root, "extensions"),
    path.join(root, "debug-bundles"),
    logDir()
  ]) fs.mkdirSync(dir, { recursive: true });
  const targetConfig = path.join(root, "config.json");
  if (!fs.existsSync(targetConfig)) {
    fs.copyFileSync(path.join(componentAppRoot, "config.json"), targetConfig);
  }
}

function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(buildInfoPath(), "utf8"));
  } catch {
    return { commit: "development", builtAt: "", channel: "development" };
  }
}

function readSettings() {
  try {
    const settings = normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(), "utf8")));
    if(managedCloud)settings.runtimeMode='server';
    cachedSettings = settings;
    return settings;
  } catch {
    return cachedSettings || normalizeSettings(DEFAULT_SETTINGS);
  }
}

async function encryptSecrets(secrets) {
  const plain = JSON.stringify(secrets);
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储暂不可用，无法保存密码和密钥");
  const encrypted = safeStorage.encryptStringAsync
    ? await safeStorage.encryptStringAsync(plain)
    : safeStorage.encryptString(plain);
  fs.writeFileSync(secretsPath(), encrypted, { mode: 0o600 });
  cachedSecrets = { ...secrets };
}

async function readSecrets() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(secretsPath())) return {};
    const encrypted = fs.readFileSync(secretsPath());
    const decrypted = safeStorage.decryptStringAsync
      ? await safeStorage.decryptStringAsync(encrypted)
      : safeStorage.decryptString(encrypted);
    const plain = decryptedText(decrypted);
    const value = JSON.parse(plain);
    if (value && typeof value === "object") {
      cachedSecrets = value;
      return value;
    }
    return cachedSecrets || {};
  } catch {
    return cachedSecrets || {};
  }
}

async function warmConfiguration() {
  if (safeStorage.isAsyncEncryptionAvailable) await safeStorage.isAsyncEncryptionAvailable();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    readSettings();
    await readSecrets();
    const settingsReady = !fs.existsSync(settingsPath()) || cachedSettings !== null;
    const secretsReady = !fs.existsSync(secretsPath()) || cachedSecrets !== null;
    if (settingsReady && secretsReady) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("本机配置文件存在，但启动时无法读取；请重启软件后再试");
}

async function importBundledUpdateToken() {
  if (!app.isPackaged) return false;
  const bundledPath = bundledUpdateTokenPath();
  if (!fs.existsSync(bundledPath)) return false;
  const token = String(fs.readFileSync(bundledPath, "utf8") || "").trim();
  if (!token) return false;
  const secrets = await readSecrets();
  if (secrets.githubUpdateToken !== token) {
    await encryptSecrets({ ...secrets, githubUpdateToken: token });
  }
  try {
    fs.rmSync(bundledPath);
  } catch (error) {
    appendLog(`内置更新凭据已加密保存，但安装目录副本未能删除：${error.message}`, "error");
  }
  return true;
}

function secretFlags(secrets) {
  return Object.fromEntries(SECRET_FIELDS.map((key) => [key, Boolean(String(secrets[key] || "").trim())]));
}

async function publicSettings() {
  const firstRun = !fs.existsSync(settingsPath()) || readSettings().firstRunPending === true;
  const settings = readSettings();
  const secrets = await readSecrets();
  return { ...settings, runtimeMode:runtimeMode(), firstRun:false, legacyClient:!managedCloud&&settings.runtimeMode==='client', secretFlags: secretFlags(secrets) };
}

function appendLog(message, level = "info") {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}`;
  recentLog.push({ line, level });
  if (recentLog.length > 300) recentLog = recentLog.slice(-300);
  fs.mkdirSync(logDir(), { recursive: true });
  fs.appendFileSync(currentLogPath(), `${line}\n`, "utf8");
  mainWindow?.webContents.send("inventory:log", { line, level });
}

function emitState(extra = {}) {
  let monthlySalesDueMonth = "";
  try {
    monthlySalesDueMonth = readMonthlySalesDashboard(inventoryDatabasePath()).dueMonth;
  } catch {
    monthlySalesDueMonth = latestCompleteMonth();
  }
  const payload = {
    schedulingOwner:agentManaged?'agent':'legacy',
    legacyAutomaticRemindersEnabled:!agentManaged,
    running: Boolean(runningChild),
    runningKind,
    stopRequested: stopRequestedPid !== null,
    nextScheduledRun: nextScheduledRun?.toISOString() || "",
    nextMonthlyScheduledRun: nextMonthlyScheduledRun?.toISOString() || "",
    monthlySalesDueMonth,
    queuedTasks: scheduledTaskQueue.map((item) => item.kind),
    logPath: currentLogPath(),
    ...extra
  };
  mainWindow?.webContents.send("inventory:state", payload);
  return payload;
}

function createWindow() {
  const branding = currentBranding();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 680,
    title: '云仓同步 · 五成电子商务工作台',
    icon: path.join(desktopDir, "assets", "lingtu-icon.png"),
    backgroundColor: "#f4f1ec",
    show: !process.argv.includes("--hidden"),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(rendererPath, managedCloud ? {query:{module:'warehouse'}} : {});
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("close", (event) => {
    const settings = readSettings();
    if (!quitting && (settings.runtimeMode === "server" || settings.scheduleEnabled || settings.monthlySalesEnabled)) {
      event.preventDefault();
      mainWindow.hide();
      appendLog("窗口已隐藏，定时任务继续运行。再次启动软件可恢复窗口。");
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function buildEnvironment(settings, secrets, kind = "sync") {
  const inventoryTask = kind === "sync";
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    CAINIAO_APP_DATA_DIR: appDataDir(),
    ERP_DATA_DIR: path.join(appDataDir(), "data"),
    CAINIAO_AUTO_LOGIN_RECOVERY: "1",
    CAINIAO_USERNAME: settings.cainiaoUsername,
    CAINIAO_PASSWORD: secrets.cainiaoPassword || "",
    BUSINESS_TIME_ZONE: "Asia/Shanghai",
    LOW_STOCK_THRESHOLD: String(settings.lowStockThreshold),
    DINGTALK_SKIP_SEND: inventoryTask ? "0" : "1",
    DINGTALK_INVENTORY_REPORT_ENABLED: inventoryTask ? "true" : "false",
    DINGTALK_REMINDER_ENABLED: "false",
    DINGTALK_DELIVERY_MODE: settings.deliveryMode,
    DINGTALK_CLIENT_ID: secrets.dingtalkClientId || "",
    DINGTALK_CLIENT_SECRET: secrets.dingtalkClientSecret || "",
    DINGTALK_REMINDER_ROBOT_CODE: settings.dingtalkRobotCode,
    DINGTALK_REMINDER_CONVERSATION_ID: settings.dingtalkConversationId,
    DINGTALK_REMINDER_TARGET_USER_ID: settings.dingtalkTargetUserId,
    DINGTALK_REMINDER_TARGET_NAME: settings.dingtalkTargetName,
    DINGTALK_WEBHOOK: secrets.dingtalkWebhook || "",
    DINGTALK_SECRET: secrets.dingtalkWebhookSecret || ""
  };
}

function taskDefinition(kind, options = {}) {
  if (kind === "login") return { scriptName: "playwright-login.js", args: [], label: "菜鸟登录" };
  if (kind === "sync") return { scriptName: "sync-cainiao-inventory.js", args: [], label: "库存同步" };
  if (kind === "monthly-sales") return {
    scriptName: "sync-cainiao-monthly-sales.js",
    args: ["--month", assertMonthInput(options.month)],
    label: `${options.month} 月销量同步`
  };
  if (kind === "monthly-backfill") return {
    scriptName: "backfill-cainiao-monthly-sales.js",
    args: ["--from", assertMonthInput(options.from), "--to", assertMonthInput(options.to)],
    label: `${options.from} 至 ${options.to} 月销量补抓`
  };
  throw new Error(`未知任务类型：${kind}`);
}

function currentBranding() {
  return buildBranding(readBuildInfo().channel || (app.isPackaged ? "release" : "development"));
}

async function startProcess(kind, trigger = "manual", options = {}, context = {}) {
  if(agentManaged)throw Object.assign(Error('Agent管理模式须从中央任务结果页复核后执行'),{code:'AGENT_REVIEW_REQUIRED'});
  if(fs.existsSync(path.join(app.getPath('userData'),'.workbench-maintenance.json')))throw Object.assign(Error('账本正在迁移维护，恢复并核对完成前不能执行任务'),{code:'MODULE_MAINTENANCE'});
  if (runningChild || runningTaskPromise) throw new Error("已有任务正在运行，请等待完成");
  const definition = taskDefinition(kind, options);
  const settings = readSettings();
  const secrets = await readSecrets();
  const flags = secretFlags(secrets);
  const validation = kind === "sync"
    ? validateSettings(settings, flags)
    : validateCainiaoSettings(settings, flags);
  if (!validation.ok) throw new Error(validation.errors.join("；"));
  const scriptPath = path.join(componentAppRoot, "core", definition.scriptName);
  if(kind==='sync'&&!fs.existsSync(inventoryDatabasePath())){
    process.env.ERP_DATA_DIR=path.dirname(inventoryDatabasePath());
    const {getDb}=await import('../core/erp/db.js');getDb();
  }
  const releaseTaskLock = acquireTaskLock(kind);
  const startedAt = new Date().toISOString();
  let syncRunId='';
  try{if(kind==='sync')syncRunId=dailyService().beginRun({expectedSourceDate:process.env.CAINIAO_EXPECTED_SOURCE_DATE||process.env.CAINIAO_INVENTORY_QUERY_DATE||expectedInventoryDate()});}
  catch(error){releaseTaskLock();throw error;}
  const logStart = recentLog.length;
  runningKind = kind;
  const triggerLabel = trigger === "schedule" ? "定时" : (["remote","tailscale"].includes(trigger) ? "远程" : "手动");
  const actorLabel = context.requestedBy ? `，发起人 ${context.requestedBy}` : "";
  appendLog(`启动${definition.label}（${triggerLabel}${actorLabel}）…`);

  let child;
  try {
    child = spawn(process.execPath, [scriptPath, ...definition.args], {
      cwd: appDataDir(),
      env: {...buildEnvironment(settings, secrets, kind),...(syncRunId?{WAREHOUSE_SYNC_RUN_ID:syncRunId}:{})},
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if(syncRunId)dailyService().updateRun(syncRunId,{error:'采集进程未启动',finishedAt:new Date().toISOString()});
    releaseTaskLock();
    runningKind = "";
    throw error;
  }
  runningChild = child;
  let resolveTask;
  const completion = new Promise((resolve) => { resolveTask = resolve; });
  runningTaskPromise = completion;
  emitState();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const consume = (chunk, level) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) appendLog(line, level);
  };
  child.stdout.on("data", (chunk) => consume(chunk, "info"));
  child.stderr.on("data", (chunk) => consume(chunk, "error"));
  child.on("error", (error) => appendLog(`任务启动失败：${error.message}`, "error"));
  child.once("close", (code) => {
    const cancelled = stopRequestedPid === child.pid;
    const success = code === 0 && !cancelled;
    if(syncRunId)dailyService().updateRun(syncRunId,{finishedAt:new Date().toISOString(),...(!success?{error:cancelled?'任务已中止':'本次同步未完成，请查看运行日志'}:{})});
    appendLog(
      cancelled ? "当前任务已由用户强制中止。" : (success ? "任务执行完成。" : `任务已停止，退出码 ${code ?? "未知"}。`),
      success ? "success" : (cancelled ? "info" : "error")
    );
    releaseTaskLock();
    runningChild = null;
    runningKind = "";
    if (cancelled) stopRequestedPid = null;
    emitState({ lastResult: cancelled ? "cancelled" : (success ? "success" : "failed"), lastFinishedAt: new Date().toISOString() });
    if (success && kind === "sync") mainWindow?.webContents.send("inventory:updated");
    if (success && ["monthly-sales", "monthly-backfill"].includes(kind)) mainWindow?.webContents.send("monthly-sales:updated");
    resolveTask({
      success,
      cancelled,
      exitCode: code,
      kind,
      startedAt,
      finishedAt: new Date().toISOString(),
      logs: recentLog.slice(logStart)
    });
    if (runningTaskPromise === completion) runningTaskPromise = null;
    scheduledTaskQueue = queueAfterTaskResult(scheduledTaskQueue, { success, cancelled });
    if (success && !cancelled) queueMicrotask(() => runNextScheduledTask());
  });
  return { started: true };
}

async function stopCurrentTask() {
  const child = runningChild;
  const completion = runningTaskPromise;
  if (!child || !completion) return { stopped: false, message: "当前没有正在运行的任务" };

  stopRequestedPid = child.pid;
  scheduledTaskQueue = [];
  appendLog("正在强制中止当前任务…");
  emitState({ stopRequested: true });
  try {
    await terminateProcessTree(child);
    const result = await completion;
    return { stopped: true, kind: result.kind };
  } catch (error) {
    stopRequestedPid = null;
    appendLog(`强制中止失败：${error.message}`, "error");
    emitState();
    throw error;
  }
}

async function runProcessAndWait(kind, trigger) {
  await startProcess(kind, trigger);
  const completion = runningTaskPromise;
  if (!completion) throw new Error("任务未能进入运行状态");
  return completion;
}

function readRecentLogLines(limit = 30) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  try {
    return fs.readFileSync(currentLogPath(), "utf8").split(/\r?\n/).filter(Boolean).slice(-safeLimit);
  } catch {
    return [];
  }
}

function fileDiagnostic(file) {
  try {
    const stat = fs.statSync(file);
    return {
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ageHours: Math.round(((Date.now() - stat.mtimeMs) / 3_600_000) * 10) / 10
    };
  } catch {
    return { exists: false };
  }
}

function jsonDiagnostic(file, summarize = () => ({})) {
  const info = fileDiagnostic(file);
  if (!info.exists) return { ...info, validJson: false };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...info, validJson: true, ...summarize(value) };
  } catch (error) {
    return { ...info, validJson: false, error: String(error?.message || error) };
  }
}

function pathAccess(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    return { readable: true, writable: true };
  } catch {
    try {
      fs.accessSync(file, fs.constants.R_OK);
      return { readable: true, writable: false };
    } catch {
      return { readable: false, writable: false };
    }
  }
}

function lockDiagnostic(file) {
  const info = jsonDiagnostic(file, (value) => {
    const pid = Number(value?.pid);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      kind: String(value?.kind || ""),
      startedAt: String(value?.startedAt || ""),
      processAlive: isProcessAlive(pid)
    };
  });
  return { ...info, stale: Boolean(info.exists && (!info.validJson || !info.processAlive)) };
}

async function latestInventoryValidation(databasePath) {
  if (!fs.existsSync(databasePath)) return { available: false, reason: "database_missing" };
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(databasePath, { readOnly: true });
    const table = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'inventory_data_validations'").get();
    if (!table) return { available: false, reason: "table_missing" };
    const row = database.prepare(
      `SELECT source_date AS sourceDate, expected_source_date AS expectedSourceDate,
              status, row_count AS rowCount, total_quantity AS totalQuantity,
              created_at AS createdAt
         FROM inventory_data_validations
        WHERE warehouse_id = 'cainiao'
        ORDER BY id DESC LIMIT 1`
    ).get();
    return row ? { available: true, ...row } : { available: false, reason: "no_validation" };
  } catch (error) {
    return { available: false, reason: "query_failed", error: String(error?.message || error) };
  } finally {
    database?.close();
  }
}

async function diagnosticSensitiveValues() {
  const settings = readSettings();
  const secrets = await readSecrets();
  return [settings.cainiaoUsername, ...Object.values(secrets)].filter(Boolean);
}

async function searchDebugLogs(options = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(currentLogPath(), "utf8").split(/\r?\n/).filter(Boolean).slice(-2000);
  } catch {
    // No log file is a valid state before the first GUI start.
  }
  return searchDiagnosticLines(lines, { ...options, sensitiveValues: await diagnosticSensitiveValues() });
}

async function collectDiagnostics() {
  const root = appDataDir();
  const settings = readSettings();
  const secrets = await readSecrets();
  const flags = secretFlags(secrets);
  const configPath = path.join(root, "config.json");
  const authPath = path.join(root, "tests", ".auth", "cainiao.json");
  const databasePath = path.join(root, "data", "erp.sqlite");
  const config = jsonDiagnostic(configPath, (value) => ({
    topLevelKeys: value && typeof value === "object" ? Object.keys(value).sort() : []
  }));
  const auth = jsonDiagnostic(authPath, (value) => ({
    cookieCount: Array.isArray(value?.cookies) ? value.cookies.length : 0,
    originCount: Array.isArray(value?.origins) ? value.origins.length : 0
  }));
  const database = { ...fileDiagnostic(databasePath), latestValidation: await latestInventoryValidation(databasePath) };
  const desktopLock = lockDiagnostic(desktopTaskLockPath());
  const cloudLock = lockDiagnostic(path.join(root, "state", "cloud-sync.lock"));
  const coreScripts = Object.fromEntries(["sync-cainiao-inventory.js", "playwright-login.js"].map((name) => [name, fs.existsSync(path.join(componentAppRoot, "core", name))]));
  const accountConfigured = Boolean(settings.cainiaoUsername && flags.cainiaoPassword);
  const robotConfigured = settings.deliveryMode === "app"
    ? Boolean(settings.dingtalkRobotCode && settings.dingtalkConversationId && flags.dingtalkClientId && flags.dingtalkClientSecret)
    : Boolean(flags.dingtalkWebhook);
  const workspaceAccess = pathAccess(root);
  const checks = [
    { id: "workspace", status: workspaceAccess.readable && workspaceAccess.writable ? "ok" : "error", message: workspaceAccess.writable ? "工作目录可读写" : "工作目录不可写" },
    { id: "config", status: config.validJson ? "ok" : "error", message: config.validJson ? "config.json 可解析" : "config.json 缺失或无法解析" },
    { id: "secrets", status: safeStorage.isEncryptionAvailable() ? "ok" : "error", message: safeStorage.isEncryptionAvailable() ? "Windows 安全存储可用" : "Windows 安全存储不可用" },
    { id: "account", status: accountConfigured ? "ok" : "warning", message: accountConfigured ? "菜鸟账号配置完整" : "菜鸟账号配置不完整" },
    { id: "robot", status: robotConfigured ? "ok" : "warning", message: robotConfigured ? "钉钉机器人配置完整" : "钉钉机器人配置不完整" },
    { id: "auth", status: auth.exists && auth.validJson ? "ok" : "warning", message: auth.exists && auth.validJson ? "登录态文件结构有效，但不能仅凭文件判断会话仍在线" : "登录态文件缺失或损坏" },
    { id: "core", status: Object.values(coreScripts).every(Boolean) ? "ok" : "error", message: Object.values(coreScripts).every(Boolean) ? "核心脚本完整" : "核心脚本缺失" },
    { id: "desktop_lock", status: desktopLock.stale ? "warning" : "ok", message: desktopLock.stale ? "发现桌面任务陈旧锁" : (desktopLock.processAlive ? "桌面任务正在运行" : "无桌面任务锁") },
    { id: "cloud_lock", status: cloudLock.stale ? "warning" : "ok", message: cloudLock.stale ? "发现云同步陈旧锁，执行前必须核对进程和日志" : (cloudLock.processAlive ? "云同步进程正在运行" : "无云同步锁") },
    { id: "validation", status: database.latestValidation.available ? (database.latestValidation.status === "valid" ? "ok" : "warning") : "warning", message: database.latestValidation.available ? `最近库存校验状态：${database.latestValidation.status}` : "尚无可读取的库存校验记录" }
  ];
  const recommendations = [];
  if (!accountConfigured) recommendations.push("先在设置中补齐菜鸟账号和密码。");
  if (!robotConfigured) recommendations.push("先在设置中补齐钉钉机器人和目标群配置。");
  if (!auth.exists || !auth.validJson) recommendations.push("由用户执行登录刷新；验证码或滑块必须由用户本人处理。");
  if (desktopLock.stale || cloudLock.stale) recommendations.push("不要直接删除锁；先核对锁内 PID、匹配进程和日志，再归档陈旧锁。");
  if (database.latestValidation.available && database.latestValidation.status !== "valid") recommendations.push("保持库存发布门禁，修复数据问题后重新采集，禁止绕过校验发送。");
  const recentIssues = await searchDebugLogs({ level: "error", limit: 20 });
  return {
    generatedAt: new Date().toISOString(),
    version: componentVersion,
    runtime: { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged },
    health: diagnosticHealth(checks),
    checks,
    configuration: { accountConfigured, robotConfigured, deliveryMode: settings.deliveryMode, secretValuesReturned: false },
    files: { config, auth, database },
    locks: { desktop: desktopLock, cloudSync: cloudLock },
    recentIssues,
    recommendations,
    safety: { readOnly: true, networkRequests: false, arbitraryCommands: false, secretsRedacted: true }
  };
}

function extensionRoot() {
  return path.join(appDataDir(), "extensions");
}

function publicExtensions() {
  const settings = readSettings();
  return discoverExtensions(extensionRoot(), settings.trustedExtensionIds).map((extension) => ({
    id: extension.id,
    name: extension.name,
    version: extension.version,
    apiVersion: extension.apiVersion,
    trusted: extension.trusted,
    valid: extension.valid,
    errors: extension.errors,
    actions: extension.actions,
    directory: extension.directory
  }));
}

function runtimeCapabilities() {
  const branding = currentBranding();
  const capabilities = createRuntimeCapabilities({
    version: componentVersion,
    packaged: app.isPackaged,
    executable: process.execPath,
    workspace: appDataDir(),
    sourceRoot: app.isPackaged ? "" : componentAppRoot,
    buildInfo: readBuildInfo(),
    displayName: branding.productName,
    extensions: publicExtensions()
  });
  if (componentContext) {
    capabilities.application.launchArgs = [...componentLaunchArgs];
    for (const mode of capabilities.modes) {
      if (mode.id === 'cli') mode.entry = `${JSON.stringify(process.execPath)} ${componentLaunchArgs.join(' ')} --cli <command>`;
      if (mode.id === 'mcp-stdio') mode.entry = `${JSON.stringify(process.execPath)} ${componentLaunchArgs.join(' ')} --mcp-stdio`;
    }
  }
  return capabilities;
}

async function exportDebugBundle() {
  const diagnostics = await collectDiagnostics();
  const capabilities = runtimeCapabilities();
  const logs = await searchDebugLogs({ level: "any", limit: 200 });
  const rawBundle = {
    format: "cainiao-debug-bundle/v1",
    generatedAt: new Date().toISOString(),
    capabilities,
    diagnostics,
    logs,
    reproduction: {
      safeCommands: ["--cli status", "--cli capabilities", "--cli doctor", "--cli debug-logs --level=error --limit=50"],
      note: "此包不含密钥；修复后仍需按业务门禁单独授权同步验收。"
    }
  };
  const bundle = redactDiagnosticValue(rawBundle, await diagnosticSensitiveValues());
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const name = `debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const file = path.join(appDataDir(), "debug-bundles", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return {
    path: file,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    size: Buffer.byteLength(serialized),
    bundle
  };
}

function trustExtension(id) {
  const extensions = discoverExtensions(extensionRoot(), readSettings().trustedExtensionIds);
  const extension = extensions.find((item) => item.id === id);
  if (!extension) throw new Error("未找到该扩展");
  if (!extension.valid) throw new Error(`扩展清单无效：${extension.errors.join("；")}`);
  const settings = readSettings();
  settings.trustedExtensionIds = normalizeTrustedExtensionIds([...(settings.trustedExtensionIds || []), id]);
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { id, trusted: true, version: extension.version, actions: extension.actions };
}

let componentExtensionServices;
function trustedComponentExtensionServices(){
  if(!componentContext)return undefined;
  if(!componentExtensionServices){
    const preview=process.env.LINGTU_AGENT_PREVIEW==='1',localAppData=process.env.LOCALAPPDATA;
    if(!localAppData)throw Error('组件缺少固定本机配置目录');
    const paths=agentBetaPaths({localAppData,root:path.join(localAppData,preview?'WuchengAgentBeta-preview':'WuchengAgentBeta'),preview});
    Object.assign(paths,{sharedElectronExecutable:process.execPath,sharedElectronVersion:process.versions.electron});
    if(process.env.LINGTU_REGISTRY_PATH!==paths.registryFile)throw Error('组件注册表未绑定当前测试版');
    componentExtensionServices=guardAgentServices(new ServiceManager({registryFile:paths.registryFile}),paths);
  }
  return componentExtensionServices;
}
async function callExtension({ id, action, params, confirmSideEffect = false }) {
  const extension = discoverExtensions(extensionRoot(), readSettings().trustedExtensionIds).find((item) => item.id === id);
  if (!extension) throw new Error("未找到该扩展");
  const response = await invokeTrustedExtension(extension, action, params, {
    confirmSideEffect,
    appVersion: componentVersion,
    workspace: appDataDir(),
    services: id==='lingtu.desks'?trustedComponentExtensionServices():undefined
  });
  return redactDiagnosticValue(response, await diagnosticSensitiveValues());
}

async function interfaceStatus() {
  const settings = readSettings();
  const flags = secretFlags(await readSecrets());
  const lock = readTaskLock();
  const lockActive = isProcessAlive(Number(lock?.pid));
  const accountConfigured = Boolean(settings.cainiaoUsername && flags.cainiaoPassword);
  const robotConfigured = settings.deliveryMode === "app"
    ? Boolean(settings.dingtalkRobotCode && settings.dingtalkConversationId && flags.dingtalkClientId && flags.dingtalkClientSecret)
    : Boolean(flags.dingtalkWebhook);
  return {
    version: componentVersion,
    state: runningChild || lockActive ? "busy" : "idle",
    runningKind: runningKind || (lockActive ? String(lock?.kind || "unknown") : ""),
    configured: { account: accountConfigured, robot: robotConfigured },
    deliveryMode: settings.deliveryMode,
    schedule: {
      enabled: settings.scheduleEnabled,
      time: settings.scheduleTime,
      monthlySalesEnabled: settings.monthlySalesEnabled,
      monthlySalesTime: settings.monthlySalesTime,
      startAtLogin: settings.startAtLogin
    },
    paths: { workspace: appDataDir(), log: currentLogPath() }
  };
}

function configureLoginItem(settings) {
  if(managedCloud)return; // The workbench owns the sole login startup entry.
  if (!app.isPackaged || process.env.LINGTU_ISOLATED_TEST === '1') return;
  const openAtLogin = Boolean(settings.startAtLogin);
  app.setLoginItemSettings({
    openAtLogin,
    enabled: openAtLogin,
    name: "云仓库存同步",
    path: process.execPath,
    args: [...componentLaunchArgs, ...(managedCloud ? ['--hidden','--managed-module=warehouse','--user-data-dir='+app.getPath('userData')] : ['--hidden'])]
  });
}

function configureSchedule() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = null;
  nextScheduledRun = null;
  nextMonthlyScheduledRun = null;
  if(agentManaged){emitState();return;}
  const settings = readSettings();
  configureLoginItem(settings);
  if (settings.runtimeMode === "client") {
    emitState();
    return;
  }
  if (settings.scheduleEnabled) nextScheduledRun = nextRunAt(settings.scheduleTime);
  if (settings.monthlySalesEnabled) nextMonthlyScheduledRun = nextMonthlyRunAt(settings.monthlySalesTime);
  const upcoming = [nextScheduledRun, nextMonthlyScheduledRun].filter(Boolean).sort((a, b) => a - b);
  if (!upcoming.length) {
    emitState();
    return;
  }
  const wakeAt = upcoming[0];
  const delay = Math.max(1000, wakeAt.getTime() - Date.now());
  scheduleTimer = setTimeout(async () => {
    const now = Date.now() + 1500;
    const due = [];
    if (nextScheduledRun && nextScheduledRun.getTime() <= now) due.push({ kind: "sync", options: {} });
    if (nextMonthlyScheduledRun && nextMonthlyScheduledRun.getTime() <= now) {
      due.push({ kind: "monthly-sales", options: { month: latestCompleteMonth() } });
    }
    configureSchedule();
    enqueueScheduledTasks(due);
  }, Math.min(delay, 2_147_000_000));
  emitState();
}

function enqueueScheduledTasks(tasks) {
  scheduledTaskQueue = mergeScheduledTasks(scheduledTaskQueue, tasks);
  emitState();
  void runNextScheduledTask();
}

async function runNextScheduledTask() {
  if (runningChild || runningTaskPromise || !scheduledTaskQueue.length) return;
  const task = scheduledTaskQueue.shift();
  try {
    await startProcess(task.kind, "schedule", task.options);
  } catch (error) {
    scheduledTaskQueue = [];
    appendLog(`定时任务未启动：${error.message}`, "error");
    emitState();
  }
}

function assertMonthInput(value) {
  const month = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("月份必须是 YYYY-MM 格式");
  if (month > latestCompleteMonth()) throw new Error("只能同步已经结束的完整自然月");
  return month;
}

function validateBackfillRange(payload = {}) {
  const defaults = defaultBackfillRange();
  const from = assertMonthInput(payload.from || defaults.from);
  const to = assertMonthInput(payload.to || defaults.to);
  if (from > to) throw new Error("补抓起始月份不能晚于结束月份");
  let cursor = from;
  let count = 1;
  while (cursor < to) {
    cursor = shiftMonth(cursor, 1);
    count += 1;
    if (count > 24) throw new Error("一次最多补抓 24 个完整月份");
  }
  return { from, to };
}

function localMonthlySales(filters = {}) {
  return readMonthlySalesDashboard(inventoryDatabasePath(), {
    year: String(filters.year || ""),
    selectedMonth: String(filters.selectedMonth || ""),
    scope: ["overall", "sku", "multi", "top5"].includes(filters.scope) ? filters.scope : "overall",
    seriesMode: ["top5", "top10", "all", "decliners"].includes(filters.seriesMode) ? filters.seriesMode : "top5",
    sku: String(filters.sku || "").trim()
  });
}

async function stopRemoteService() {
  const current = remoteService;
  remoteService = null;
  if (current) await current.stop();
}

async function configureRemoteService() {
  await stopRemoteService();
  // Legacy Cloudflare listeners are retired. The outer workbench owns the
  // authenticated Tailscale gateway and starts this module as a host service.
}

function openRemoteLogin() {
  throw new Error('连接与登录由工作台 Tailscale 设置统一管理');
}

ipcMain.handle("settings:get", async () => publicSettings());
ipcMain.handle('warehouse-daily:get', async event => {
  if(event.sender!==mainWindow?.webContents)throw Error('无权访问工作记录');
  if(runtimeMode()==='client')throw Error('请从工作台 Tailscale 入口打开云仓');
  return dailyStatus();
});
ipcMain.handle('warehouse-daily:action', async (event,payload={}) => {
  if(agentManaged)throw Object.assign(Error('请从中央任务结果页复核本人操作'),{code:'AGENT_REVIEW_REQUIRED'});
  if(event.sender!==mainWindow?.webContents)throw Error('无权操作工作记录');
  assertDailyAvailable();
  if(payload.action==='remind')return dailyRemind(localDailyActor,payload);
  return dailyService().action(localDailyActor,payload);
});
ipcMain.handle('warehouse-daily:config', (event,payload={}) => {
  if(agentManaged)throw Object.assign(Error('请从中央任务结果页复核员工配置'),{code:'AGENT_REVIEW_REQUIRED'});
  if(event.sender!==mainWindow?.webContents)throw Error('无权修改员工设置');
  assertDailyAvailable();
  return dailyService().configure(localDailyActor,payload);
});
ipcMain.handle('warehouse-daily:reminder-settings', async (event,payload={}) => {
  if(event.sender!==mainWindow?.webContents||runtimeMode()==='client')throw Error('提醒凭据只能在主机设置');
  assertDailyAvailable();
  const warehouseReminders=normalizeReminderSettings(payload.settings||{}),secrets={...await readSecrets()};
  for(const key of ['smtpPassword','aliyunAccessKeyId','aliyunAccessKeySecret']){
    if(payload.clearSecrets?.includes(key))delete secrets[key];
    else if(String(payload.secrets?.[key]||'').trim())secrets[key]=String(payload.secrets[key]).trim();
  }
  await encryptSecrets(secrets);
  const settings={...readSettings(),warehouseReminders};
  fs.writeFileSync(settingsPath(),JSON.stringify(settings,null,2)+'\n','utf8');cachedSettings=settings;
  return {ok:true};
});
ipcMain.handle("branding:get", () => currentBranding());
ipcMain.handle("app:about", () => ({ version: componentVersion, build: readBuildInfo(), changelog: CHANGELOG }));
ipcMain.handle("secrets:get-editable", async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("无权读取敏感设置");
  if (runtimeMode() === "client") return {};
  const secrets = await readSecrets();
  return Object.fromEntries(EDITABLE_SECRET_FIELDS.map((key) => [key, String(secrets[key] || "")]));
});
ipcMain.handle("settings:save", async (_event, payload = {}) => {
  const currentSecrets = await readSecrets();
  const incomingSecrets = payload.secrets || {};
  const mergedSecrets = { ...currentSecrets };
  for (const key of SECRET_FIELDS) {
    const value = String(incomingSecrets[key] || "").trim();
    if (value) mergedSecrets[key] = value;
  }
  const settings = normalizeSettings(payload.settings || {});
  const validation = validateSettings(settings, secretFlags(mergedSecrets));
  if (!validation.ok) throw new Error(validation.errors.join("；"));
  fs.writeFileSync(settingsPath(), `${JSON.stringify(validation.value, null, 2)}\n`, "utf8");
  await encryptSecrets(mergedSecrets);
  configureSchedule();
  appendLog("配置已保存，敏感字段已使用 Windows 安全存储加密。", "success");
  return publicSettings();
});
ipcMain.handle("settings:save-section", async (_event, payload = {}) => {
  const section = String(payload.section || "");
  if(section==='runtime')throw Error('连接与运行角色由工作台 Tailscale 设置统一管理');
  const validators = {
    runtime: validateRuntimeSettings,
    account: validateCainiaoSettings,
    robot: validateDingTalkSettings,
    automation: validateAutomationSettings,
    updates: (settings) => ({ ok: true, errors: [], value: normalizeSettings(settings) })
  };
  const validator = validators[section];
  if (!validator) throw new Error("未知的设置分区");

  const currentSettings = readSettings();
  const currentSecrets = await readSecrets();
  const incomingSecrets = payload.secrets || {};
  const mergedSecrets = { ...currentSecrets };
  for (const key of SECRET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incomingSecrets, key)) continue;
    const value = String(incomingSecrets[key] || "").trim();
    if (value) mergedSecrets[key] = value;
  }
  const settings = normalizeSettings({ ...currentSettings, ...(payload.settings || {}) });
  if (section === "runtime") delete settings.firstRunPending;
  const validation = validator(settings, secretFlags(mergedSecrets));
  if (!validation.ok) throw new Error(validation.errors.join("；"));

  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await encryptSecrets(mergedSecrets);
  configureSchedule();
  if (section === "runtime") await configureRemoteService();
  const sectionNames = { runtime: "运行模式", account: "菜鸟账号", robot: "钉钉机器人", automation: "自动任务", updates: "在线升级" };
  appendLog(`${sectionNames[section]}设置已保存。`, "success");
  return publicSettings();
});
ipcMain.handle("task:run", () => runtimeMode() === "client"
  ? remoteRequest("/api/v1/jobs", { method: "POST", body: { type: "sync" } })
  : startProcess("sync", "manual"));
ipcMain.handle("task:login", () => runtimeMode() === "client" ? openRemoteLogin() : startProcess("login", "manual"));
ipcMain.handle("task:stop", () => runtimeMode() === "client"
  ? remoteRequest("/api/v1/jobs/stop", { method: "POST", body: {} })
  : stopCurrentTask());
ipcMain.handle("task:state", () => runtimeMode() === "client" ? remoteRequest("/api/v1/task") : emitState());
ipcMain.handle("logs:get", () => runtimeMode() === "client" ? [] : recentLog);
ipcMain.handle("inventory:get", () => runtimeMode() === "client" ? remoteRequest("/api/v1/inventory") : readCainiaoInventory(inventoryDatabasePath()));
ipcMain.handle("monthly-sales:get", (_event, filters = {}) => runtimeMode() === "client"
  ? remoteRequest(`/api/v1/monthly-sales?${new URLSearchParams(filters).toString()}`)
  : localMonthlySales(filters));
ipcMain.handle("monthly-sales:sync", (_event, payload = {}) => {
  const month = assertMonthInput(payload.month || latestCompleteMonth());
  return runtimeMode() === "client"
    ? remoteRequest("/api/v1/jobs", { method: "POST", body: { type: "monthly-sales", month } })
    : startProcess("monthly-sales", "manual", { month });
});
ipcMain.handle("monthly-sales:backfill", (_event, payload = {}) => {
  const range = validateBackfillRange(payload);
  return runtimeMode() === "client"
    ? remoteRequest("/api/v1/jobs", { method: "POST", body: { type: "monthly-backfill", ...range } })
    : startProcess("monthly-backfill", "manual", range);
});
ipcMain.handle("remote:login", () => openRemoteLogin());
ipcMain.handle("remote:test", async () => {
  try {
    const health = await remoteRequest("/api/v1/health");
    notifyRemoteConnection(true, "主服务器连接成功", health);
    return { ok: true, health };
  } catch (error) {
    notifyRemoteConnection(false, error.message);
    throw error;
  }
});
ipcMain.handle("logs:open", () => shell.openPath(logDir()));
ipcMain.handle("data:open", () => shell.openPath(appDataDir()));
ipcMain.handle("repository:open", async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("无权打开外部链接");
  const url = externalLink("repository");
  await shell.openExternal(url);
  return { opened: true, url };
});
ipcMain.handle("integration:get", () => ({
  cli: { command: process.execPath, args: [...componentLaunchArgs], examples: ["--cli status", "--cli doctor", "--cli debug-bundle", "--cli capabilities", "--cli sync --confirm-send"] },
  mcp: { command: process.execPath, args: [...componentLaunchArgs, "--mcp-stdio"] },
  runtime: { apiVersion: runtimeCapabilities().schemaVersion, extensionDirectory: extensionRoot(), modes: runtimeCapabilities().modes.map((mode) => mode.id) }
}));
ipcMain.handle("update:get", () => updater?.getState() || {
  currentVersion: componentVersion, status: "idle", message: "尚未初始化"
});
ipcMain.handle("update:check", () => updater?.check() || Promise.reject(new Error("更新服务尚未初始化")));
ipcMain.handle("update:install", () => updater?.install() || Promise.reject(new Error("更新服务尚未初始化")));

function cliHelp() {
  return {
    usage: [
      "云仓库存同步.exe --cli status",
      "云仓库存同步.exe --cli capabilities",
      "云仓库存同步.exe --cli doctor",
      "云仓库存同步.exe --cli debug-logs --level=error --limit=50",
      "云仓库存同步.exe --cli debug-bundle",
      "云仓库存同步.exe --cli extensions",
      "云仓库存同步.exe --cli extension-trust --id=<extension-id> --confirm-trust-code",
      "云仓库存同步.exe --cli logs --limit=30",
      "云仓库存同步.exe --cli sync --confirm-send",
      "云仓库存同步.exe --cli send-latest-valid --confirm-send",
      "云仓库存同步.exe --cli login --confirm-open-browser",
      "云仓库存同步.exe --mcp-stdio"
    ],
    note: "sync 会发送一条钉钉库存报告，必须提供 --confirm-send"
  };
}

async function sendLatestValidInventoryReport() {
  if(agentManaged)throw Object.assign(Error('请从中央任务结果页复核本次对外发送'),{code:'AGENT_REVIEW_REQUIRED'});
  if(fs.existsSync(path.join(app.getPath('userData'),'.workbench-maintenance.json')))throw Object.assign(Error('账本正在迁移维护，当前不能发送报告'),{code:'MODULE_MAINTENANCE'});
  const settings = readSettings();
  const secrets = await readSecrets();
  const validation = validateDingTalkSettings(settings, secretFlags(secrets));
  if (!validation.ok) throw new Error(validation.errors.join("；"));

  const releaseTaskLock = acquireTaskLock("send-latest-valid");
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(inventoryDatabasePath(), { readOnly: true });
    const validated = database.prepare(
      `SELECT source_file AS sourceFile, source_date AS sourceDate,
              row_count AS rowCount, total_quantity AS totalQuantity, created_at AS createdAt
         FROM inventory_data_validations
        WHERE warehouse_id = 'cainiao' AND status = 'valid'
        ORDER BY id DESC LIMIT 1`
    ).get();
    if (!validated?.sourceDate) throw new Error("没有可发送的已校验库存快照");

    const snapshot = database.prepare(
      `SELECT snapshot_date AS snapshotDate, COUNT(*) AS rowCount,
              COALESCE(SUM(quantity), 0) AS totalQuantity
         FROM inventory_snapshots
        WHERE warehouse_id = 'cainiao' AND snapshot_date = ?`
    ).get(validated.sourceDate);
    if (!snapshot || snapshot.snapshotDate !== validated.sourceDate
      || Number(snapshot.rowCount) !== Number(validated.rowCount)
      || Math.abs(Number(snapshot.totalQuantity) - Number(validated.totalQuantity)) > 0.001) {
      throw new Error("最近有效库存快照与校验记录不一致，已停止发送");
    }

    process.env.ERP_DATA_DIR = path.join(appDataDir(), "data");
    const [{ getInventoryReport, buildInventoryMarkdown }, { sendDingTalkAppRobotMessage }] = await Promise.all([
      import("../core/erp/reports.js"),
      import("../core/dingtalk-app-robot.js")
    ]);
    const report = getInventoryReport({ warehouseId: "cainiao" });
    if (report.snapshotDate !== validated.sourceDate
      || Number(report.skuCount) !== Number(validated.rowCount)
      || Math.abs(Number(report.totalQuantity) - Number(validated.totalQuantity)) > 0.001) {
      throw new Error("库存报告与最近有效校验记录不一致，已停止发送");
    }

    const markdown = buildInventoryMarkdown("table", report);
    const notice = `> 今日新数据尚未发布，本次沿用最近已校验库存快照 **${validated.sourceDate}**。`;
    const targetPrefix = settings.dingtalkTargetUserId && settings.dingtalkTargetName
      ? `@${settings.dingtalkTargetName}\n\n`
      : "";
    const delivery = await sendDingTalkAppRobotMessage({
      clientId: secrets.dingtalkClientId,
      clientSecret: secrets.dingtalkClientSecret,
      robotCode: settings.dingtalkRobotCode || secrets.dingtalkClientId,
      conversationId: settings.dingtalkConversationId,
      msgKey: "sampleMarkdown",
      msgParam: {
        title: `${markdown.title}（沿用上一版）`,
        text: `${targetPrefix}${notice}\n\n${markdown.text}`
      }
    });
    appendLog(`已发送最近有效库存快照：来源日期 ${validated.sourceDate}，${validated.rowCount} 个 SKU，库存合计 ${validated.totalQuantity}。`, "success");
    return {
      sent: true,
      sourceDate: validated.sourceDate,
      rowCount: Number(validated.rowCount),
      totalQuantity: Number(validated.totalQuantity),
      lowStockCount: report.lowStockItems?.length || 0,
      delivery
    };
  } finally {
    database?.close();
    releaseTaskLock();
  }
}

async function runCli() {
  const args = process.argv.slice(cliArgumentIndex + 1);
  const request = parseCliRequest(args);
  if (request.command === "help") return { ok: true, ...cliHelp() };
  if (request.command === "status") return { ok: true, status: await interfaceStatus() };
  if (request.command === "capabilities") return { ok: true, capabilities: runtimeCapabilities() };
  if (request.command === "doctor") return { ok: true, diagnostics: await collectDiagnostics() };
  if (request.command === "debug-bundle") return { ok: true, ...(await exportDebugBundle()) };
  if (request.command === "extensions") return { ok: true, extensions: publicExtensions(), directory: extensionRoot() };
  if (request.command === "extension-trust") return { ok: true, extension: trustExtension(request.id) };
  if (request.command === "extension-call") {
    try {
      return { ok: true, response: await callExtension(request) };
    } catch (error) {
      return { ok: false, error: sanitizeDiagnosticText(error?.message || error, await diagnosticSensitiveValues()) };
    }
  }
  if (request.command === "logs") return { ok: true, lines: readRecentLogLines(request.limit) };
  if (request.command === "debug-logs") return { ok: true, lines: await searchDebugLogs(request) };
  if (request.command === "sync") {
    const task = await runProcessAndWait("sync", "cli");
    return { ok: task.success, ...task, logs: task.logs.slice(-100) };
  }
  if (request.command === "send-latest-valid") {
    return { ok: true, ...(await sendLatestValidInventoryReport()) };
  }
  if (request.command === "login") {
    const task = await runProcessAndWait("login", "cli");
    return { ok: task.success, ...task, logs: task.logs.slice(-100) };
  }
  throw new Error(`未知 CLI 命令：${request.command}`);
}

function writeCliResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

app.on("second-instance", () => {
  if (managedMaintenance) return;
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("settings:refresh");
});

app.on("before-quit", event => {
  cloudControl?.close();
  warehouseAgent?.close();
  warehouseAgent=null;
  quitting = true;
  if (mcpBridgeChild && !mcpBridgeChild.killed) mcpBridgeChild.kill();
  void stopRemoteService();
});
app.on("window-all-closed", () => {
  if (managedCloud) return;
  const settings = readSettings();
  if (!headlessMode && settings.runtimeMode !== "server" && !settings.scheduleEnabled && !settings.monthlySalesEnabled) app.quit();
});

app.whenReady().then(async () => {
  app.setAppUserModelId("com.diankouwujin.cainiao.inventory");
  ensureWorkspace();
  installBundledDesks({source:path.join(desktopDir,'extensions','lingtu-desks'),workspace:appDataDir(),settingsPath:settingsPath()});
  if (cliMode) {
    try {
      const result = await runCli();
      writeCliResult(result);
      process.exitCode = result.ok === false ? 1 : 0;
    } catch (error) {
      writeCliResult({ ok: false, error: String(error?.message || error || "未知错误") });
      process.exitCode = 1;
    } finally {
      app.quit();
    }
    return;
  }
  if (mcpMode) {
    const entryPath = path.join(componentAppRoot, "desktop", "mcp-stdio-entry.mjs");
    mcpBridgeChild = spawn(process.execPath, [entryPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CAINIAO_ASSISTANT_EXE: process.execPath,
        CAINIAO_ASSISTANT_APP_PATH: app.isPackaged ? "" : componentAppRoot,
        CAINIAO_ASSISTANT_USER_DATA: app.getPath("userData"),
        CAINIAO_ASSISTANT_VERSION: componentVersion
      },
      windowsHide: true,
      stdio: "inherit"
    });
    mcpBridgeChild.once("error", (error) => {
      process.stderr.write(`MCP 启动失败：${error.message}\n`);
      app.exit(1);
    });
    mcpBridgeChild.once("close", (code) => app.exit(code ?? 0));
    return;
  }
  let configurationWarmError = null;
  try {
    await warmConfiguration();
  } catch (error) {
    configurationWarmError = error;
  }
  if (managedCloud) {
    if(!fs.existsSync(inventoryDatabasePath())){
      if(process.env.LINGTU_ALLOW_INITIALIZE!=='1')throw Object.assign(Error('原云仓账本不存在，已阻止创建空账本'),{code:'MISSING_LEDGER'});
      process.env.ERP_DATA_DIR=path.dirname(inventoryDatabasePath());
      const {getDb}=await import('../core/erp/db.js');
      getDb(); // Real ERP schema and migrations; only explicit first installation.
    }
    cloudControl = await startCloudControl({
      root: componentAppRoot, dataDir: app.getPath('userData'), version: componentVersion,
      busy: () => !!runningChild || !!runningTaskPromise || reminderWork>0,
      migration: {databasePath:inventoryDatabasePath(),dataDir:app.getPath('userData')},
      business: {
        agentManaged,
        getAgentAdapter: agentManaged?async key=>{
          if(!warehouseAgent){const {verifyAgentApproval}=await import('./agent-runtime/approval.mjs');warehouseAgent=createWarehouseAgentAdapter({databasePath:inventoryDatabasePath(),workspace:appDataDir(),settingsPath:settingsPath(),secretsPath:secretsPath(),workbenchKey:key,verifyApproval:verifyAgentApproval,getEnvironment:async()=>buildEnvironment(readSettings(),await readSecrets(),'sync'),collectDiagnostics,searchDebugLogs,exportDebugBundle,getConfiguration:publicSettings,senders:createWarehouseReminderSenders({readSettings,readSecrets}),getChannels:async()=>reminderChannelStates(readSettings().warehouseReminders,await readSecrets(),readSettings())});}
          return warehouseAgent;
        }:undefined,
        getDailyStatus: actor => dailyStatus(actor),
        dailyAction: (actor,payload) => dailyService().action(actor,payload),
        saveDailyConfig: (actor,payload) => dailyService().configure(actor,payload),
        remindDaily: (actor,payload) => dailyRemind(actor,payload),
        getInventory: async () => readCainiaoInventory(inventoryDatabasePath()),
        getMonthlySales: async filters => localMonthlySales(filters),
        getTaskState: async () => {
          const {logPath:_localPath,...state}=emitState(),secrets=Object.values(await readSecrets()).filter(v=>typeof v==='string'&&v.length>=5);
          const start=recentLog.findLastIndex(r=>/启动.*（/.test(r.line)),logs=recentLog.slice(Math.max(0,start)).slice(-100).map(r=>({level:r.level,line:sanitizeDiagnosticText(r.line,secrets).replace(/[A-Z]:[\\/][^\r\n"'<>]+/gi,'[主机路径]')}));
          const waiting=!state.running&&logs.some(r=>/未登录|登录.*(?:失效|过期)|验证码|扫码|需要.*登录|login.*(?:required|expired)/i.test(r.line));
          return {...state,logs,phase:waiting?'waiting-host-action':state.running?'running':'idle',...(waiting?{state:'waiting-host-action',message:'等待主服务器人工处理：请在主机完成登录、验证码或平台授权后重试'}:{})};
        },
        startTask: async (kind,trigger,options,actor) => startProcess(kind,trigger,options,actor),
        stopTask: async () => stopCurrentTask(),
        requestLogin: async actor => startProcess('login','tailscale',{},actor),
        sendLatestValid: async actor => sendLatestValidInventoryReport(actor)
      },
      activate: async () => {
        if (managedMaintenance) { managedMaintenance = false; configureSchedule(); await configureRemoteService(); }
      },
      open: async () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); mainWindow.show(); mainWindow.focus(); },
      stop: () => app.quit()
    });
    if (managedMaintenance) return;
  }
  createWindow();
  const importedUpdateToken = await importBundledUpdateToken();
  if (importedUpdateToken) appendLog("在线升级凭据已内置并转存到 Windows 安全存储。", "success");
  updater = createUpdater({
    app: componentContext ? {isPackaged: app.isPackaged, getVersion: () => componentVersion} : app,
    getToken: async () => (await readSecrets()).githubUpdateToken,
    onState: (state) => mainWindow?.webContents.send("update:state", state),
    log: appendLog
  });
  if (!managedCloud) updater.initialize();
  configureSchedule();
  if(!agentManaged)reminderTimer=setInterval(async()=>{
    if(reminderWork||managedMaintenance||fs.existsSync(path.join(app.getPath('userData'),'.workbench-maintenance.json'))||!fs.existsSync(inventoryDatabasePath()))return;
    reminderWork++;
    try{await dailyService().tick();}catch{appendLog('员工自动提醒检查失败，请核对签到管理配置','error');}finally{reminderWork--;}
  },30000);
  reminderTimer?.unref();
  try {
    await configureRemoteService();
  } catch {
    // The startup error is already recorded and the settings UI remains available for repair.
  }
  appendLog("云仓库存同步已启动。", "success");
  if (configurationWarmError) appendLog(`配置自检失败：${configurationWarmError.message}`, "error");
  else appendLog("配置与 Windows 安全存储自检通过。", "success");
});
