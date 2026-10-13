"""Local monitoring ledger/UI with an application-owned daily timer.

This program cannot issue invoices or modify platform applications.
"""
from __future__ import annotations

import argparse
from console_bridge import install_console_bridge
install_console_bridge()
from contextlib import closing
from datetime import date, datetime, timezone, timedelta
import json
import os
from pathlib import Path
import sqlite3
import uuid

CN = timezone(timedelta(hours=8))
COVERAGES = ("platform_available_range", "visible_range", "unknown")
OUTCOMES = ("observed", "needs_login", "error")


def default_root():
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "WuchengInvoiceAssistant" / "Monitoring"


def validate_observation(value):
    result = dict(value)
    if not isinstance(result.get("shop"), str) or not result["shop"].strip():
        raise ValueError("必须提供已经核实的店铺名称，失败时可写当前目标店铺")
    result["shop"] = result["shop"].strip()
    if result.get("outcome") not in OUTCOMES or result.get("coverage") not in COVERAGES:
        raise ValueError("检查结果或查询覆盖范围无效")
    for key in ("pending_count", "unrecorded_count"):
        count = result.get(key)
        if count is not None and (type(count) is not int or count < 0):
            raise ValueError("申请数量必须是非负整数，未知不能填零")
    if result["outcome"] != "observed":
        if any(result.get(k) is not None for k in ("pending_count", "unrecorded_count")):
            raise ValueError("登录或查询失败时不能记录成功数量")
        if not result.get("message", "").strip():
            raise ValueError("失败时必须记录原因")
        result["coverage"] = "unknown"
        result["state"] = result["outcome"]
    else:
        if any(result.get(k) is None for k in ("pending_count", "unrecorded_count")):
            raise ValueError("正常观察必须核实两个申请状态的数量")
        if not result.get("fresh_query"):
            raise ValueError("必须执行本次实时查询，旧截图或旧导出不能作为每日检查")
        start = date.fromisoformat(result.get("scope_start", ""))
        end = date.fromisoformat(result.get("scope_end", ""))
        if start > end or end > datetime.now(CN).date():
            raise ValueError("日期范围无效或结束日期在未来")
        if result["coverage"] == "unknown":
            raise ValueError("成功观察必须明确实际查询范围")
        if result["pending_count"] or result["unrecorded_count"]:
            result["state"] = "attention"
        elif result["coverage"] != "platform_available_range":
            result["state"] = "partial"
        else:
            result["state"] = "clear"
    result["checked_at"] = datetime.now(CN).isoformat(timespec="seconds")
    result["id"] = uuid.uuid4().hex
    return result


def database(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "invoice-monitor.sqlite3", timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY, checked_at TEXT NOT NULL, shop TEXT NOT NULL, payload TEXT NOT NULL)")
    return conn


def record(root, observation):
    result = validate_observation(observation)
    with closing(database(root)) as conn, conn:
        conn.execute("INSERT INTO checks VALUES(?,?,?,?)", (result["id"], result["checked_at"], result["shop"], json.dumps(result, ensure_ascii=False)))
    return result


def history(root, limit=100):
    conn = database(root)
    try:
        return [json.loads(row["payload"]) for row in conn.execute("SELECT payload FROM checks ORDER BY checked_at DESC,rowid DESC LIMIT ?", (limit,))]
    finally:
        conn.close()


def describe(item):
    state = item["state"]
    if state == "needs_login":
        return "需要登录：" + item["message"]
    if state == "error":
        return "检查失败：" + item["message"]
    counts = f"待处理 {item['pending_count']}；待录入 {item['unrecorded_count']}"
    scope = f"{item['scope_start']} 至 {item['scope_end']}"
    coverage = "已核实平台可查询范围" if item["coverage"] == "platform_available_range" else "仅当前日期范围，不代表全部历史"
    return f"{counts}　{scope}（{coverage}）。待录入不等于尚未开具。"


def process_result(result, exit_code, *, connect=False, timed_out=False):
    """Business outcome is authoritative; exit 0 alone is not success."""
    success = (isinstance(result, dict) and not timed_out and exit_code == 0
               and (result.get("connected") is True if connect else result.get("outcome") == "observed"))
    if success:
        return "INFO", ("连接成功" if connect else "检查成功") + f"；子进程退出码 {exit_code}。"
    status = "需要登录，数量未知" if isinstance(result, dict) and result.get("outcome") == "needs_login" else "连接失败" if connect else "检查失败，数量未知"
    return "ERROR", status + f"；子进程退出码 {exit_code}" + ("；超过运行时限" if timed_out else "") + "。请查看同一任务的前序日志。"


def gui(root):
    import sys
    from invoice_assistant.watch_runtime import config, save_config, claim_due, next_due
    from invoice_assistant.watch_logs import append_log
    from invoice_assistant.watch_log_panel import LogPanel
    from PySide6.QtCore import QTimer, QUrl, QTime, QProcess, QLockFile, QProcessEnvironment
    from PySide6.QtGui import QDesktopServices, QAction
    from PySide6.QtWidgets import QApplication, QLabel, QPushButton, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget, QHeaderView, QCheckBox, QTimeEdit, QHBoxLayout, QSystemTrayIcon, QMenu, QStyle, QMessageBox
    app = QApplication.instance() or QApplication([])
    Path(root).mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(Path(root) / "monitor-gui.lock"))
    if not lock.tryLock(100):
        QMessageBox.information(None, "每日开票巡检", "巡检程序已运行，请从任务栏或托盘打开，避免重复调度。")
        return 0
    settings = config(root)
    tray = QSystemTrayIcon(app.style().standardIcon(QStyle.SP_ComputerIcon), app)

    class MonitorWindow(QWidget):
        quitting = False

        def closeEvent(self, event):
            if not self.quitting and QSystemTrayIcon.isSystemTrayAvailable():
                event.ignore()
                self.hide()
                tray.showMessage("每日开票巡检", "已最小化到托盘；程序仍会按设定时间检查。")
            else:
                event.accept()

    window = MonitorWindow()
    window.setWindowTitle("每日开票巡检 · 本地定时")
    window.resize(1150, 820)
    window.setStyleSheet("QWidget {background:#f5f7fb;color:#24334b;font:14px 'Microsoft YaHei';} QPushButton {background:#2464df;color:white;border:0;border-radius:6px;padding:10px;} QTableWidget {background:white;border:1px solid #dce3ee;} QLabel {padding:6px;}")
    layout = QVBoxLayout(window)
    layout.addWidget(QLabel("每日开票巡检 · 程序内定时任务（北京时间）"))
    layout.addWidget(QLabel("直接读取已登录千牛，不打开浏览器，不依赖 Codex。请保持程序运行、千牛已登录、电脑联网且桌面解锁。\n只检查，不开票、不导出、不回传。关闭本窗口留在托盘；客户端改版或读取失败会提示，不记成零。"))
    controls = QHBoxLayout()
    enabled = QCheckBox("每天自动检查")
    enabled.setChecked(settings["enabled"])
    clock = QTimeEdit(QTime.fromString(settings["time"], "HH:mm"))
    clock.setDisplayFormat("HH:mm")
    save = QPushButton("保存定时设置")
    controls.addWidget(enabled)
    controls.addWidget(clock)
    controls.addWidget(save)
    layout.addLayout(controls)
    schedule_status = QLabel()
    layout.addWidget(schedule_status)
    action_status = QLabel("首次使用：千牛切到目标店铺 → 连接已登录千牛 → 立即检查。历史记录不是本次实时结果。")
    action_status.setWordWrap(True)
    layout.addWidget(action_status)
    worker = QProcess(window)
    active = {"login": False, "last_id": None, "output": "", "run_id": "", "failed": False, "timed_out": False}
    worker.setProcessChannelMode(QProcess.MergedChannels)
    environment = QProcessEnvironment.systemEnvironment()
    environment.insert("PYTHONIOENCODING", "utf-8")
    worker.setProcessEnvironment(environment)
    watchdog = QTimer(window)
    watchdog.setSingleShot(True)
    watchdog.setInterval(120000)
    def timeout():
        active["timed_out"] = True
        append_log(root, "ERROR", "执行超时", "检查超过 120 秒，已终止只读子进程；数量未知，请保持桌面解锁后重试。", run_id=active["run_id"], code="WORKER_TIMEOUT")
        worker.kill()  # Read-only worker; no invoice submission to interrupt.
    watchdog.timeout.connect(timeout)
    def drain():
        active["output"] = (active["output"] + bytes(worker.readAllStandardOutput()).decode("utf-8", errors="replace"))[-16000:]
    worker.readyReadStandardOutput.connect(drain)

    def launch(login=False, scheduled=False):
        if worker.state() != QProcess.NotRunning:
            action_status.setText("正在连接或检查中，请勿重复操作。")
            return
        active["login"] = login
        active["output"] = ""
        active.update(run_id=uuid.uuid4().hex, failed=False, timed_out=False)
        append_log(root, "INFO", "任务启动", ("定时检查" if scheduled else "手动连接" if login else "手动检查") + "已启动，请暂时不要切换千牛账号。", run_id=active["run_id"])
        rows = history(root)
        active["last_id"] = rows[0]["id"] if rows else None
        action_status.setText("正在连接当前千牛账号，不打开浏览器…" if login else "正在读取千牛客户端；请暂时不要切换店铺或操作查询页面。")
        script = str(Path(__file__).resolve())
        executable = sys.executable
        if Path(executable).name.lower() == "pythonw.exe":
            executable = str(Path(executable).with_name("python.exe"))
        worker.start(executable, [script, "--data-dir", str(root), "--run-id", active["run_id"], "connect" if login else "check"])
        watchdog.start()

    actions = QHBoxLayout()
    login_button = QPushButton("① 连接已登录千牛")
    check_button = QPushButton("② 立即检查")
    login_button.clicked.connect(lambda: launch(True))
    check_button.clicked.connect(lambda: launch(False))
    actions.addWidget(login_button)
    actions.addWidget(check_button)
    layout.addLayout(actions)

    def persist():
        settings.update(enabled=enabled.isChecked(), time=clock.time().toString("HH:mm"))
        save_config(root, settings)
        append_log(root, "INFO", "定时设置", f"每天 {settings['time']}，{'已启用' if settings['enabled'] else '已暂停'}；仅程序运行时生效。")
        tick()

    def tick():
        now = datetime.now(CN)
        schedule_status.setText("下次计划：" + next_due(settings, now) + "（仅程序运行时生效；睡眠后当天补查一次）")
        if worker.state() == QProcess.NotRunning and claim_due(root, settings, now):
            launch(scheduled=True)

    save.clicked.connect(persist)
    summary = QLabel()
    summary.setWordWrap(True)
    layout.addWidget(summary)
    table = QTableWidget(0, 4)
    table.setHorizontalHeaderLabels(["检查时间", "店铺", "结果", "查询范围与说明"])
    table.horizontalHeader().setSectionResizeMode(3, QHeaderView.Stretch)
    table.setColumnWidth(0, 200)
    table.setColumnWidth(1, 150)
    table.setColumnWidth(2, 110)
    table.setEditTriggers(QTableWidget.NoEditTriggers)
    table.setWordWrap(True)
    table.setMinimumHeight(140)
    layout.addWidget(table, 1)
    labels = {"attention": "有待核对申请", "clear": "范围内无申请", "partial": "仅部分范围", "error": "检查失败", "needs_login": "需要登录"}

    def refresh():
        rows = history(root)
        summary.setText("尚无检查记录，不能视为没有待开票申请。" if not rows else f"最近检查：{rows[0]['checked_at']}　{describe(rows[0])}")
        table.setRowCount(len(rows))
        for index, row in enumerate(rows):
            for col, value in enumerate((row["checked_at"], row["shop"], labels[row["state"]], describe(row))):
                table.setItem(index, col, QTableWidgetItem(value))
        table.resizeRowsToContents()

    button = QPushButton("刷新检查记录")
    button.clicked.connect(refresh)
    folder = QPushButton("打开本地记录目录")
    folder.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(root).resolve()))))
    record_actions = QHBoxLayout()
    for secondary in (button, folder):
        secondary.setStyleSheet("QPushButton {background:#e8eef9;color:#2454a3;}")
        record_actions.addWidget(secondary)
    layout.addLayout(record_actions)
    log_panel = LogPanel(root, window)
    layout.addWidget(log_panel)
    log_panel.toggle.setChecked(True)
    timer = QTimer(window)
    timer.timeout.connect(refresh)
    timer.timeout.connect(tick)
    timer.start(30000)
    def worker_failed():
        if active["failed"]:
            return
        active["failed"] = True
        record(root, {"shop": settings["shop"], "outcome": "error", "coverage": "unknown",
                      "pending_count": None, "unrecorded_count": None,
                      "run_id": active["run_id"],
                      "message": "独立检查子进程未正常完成，请展开运行日志查看失败阶段和错误码"})
        append_log(root, "ERROR", "子进程异常", "未取得本次完整检查结果，数量未知；请查看同一任务编号的前序日志。", run_id=active["run_id"], code="WORKER_INCOMPLETE")
        refresh()
        action_status.setText("本次检查失败，数量未知；历史记录不能当作本次检查结果。")

    def finished(*_):
        watchdog.stop()
        drain()
        settings.update(config(root))
        refresh()
        action_status.setText("本次操作结束，请核对最近检查记录。")
        business_result = None
        if active["login"]:
            try:
                result = json.loads(active["output"].strip().splitlines()[-1])
                business_result = result
                action_status.setText("已连接千牛账号：" + result["account"] + "。请点击②立即检查。" if result.get("connected") else "连接失败，请查看最近记录。")
                if not result.get("connected"):
                    log_panel.toggle.setChecked(True)
            except (ValueError, KeyError, IndexError):
                action_status.setText("未确认连接成功，请打开目标千牛店铺后重试。")
                append_log(root, "ERROR", "连接结果", "未取得有效连接结果，请检查前序日志及 Python 环境。", run_id=active["run_id"], code="CONNECT_INCOMPLETE")
                log_panel.toggle.setChecked(True)
        rows = history(root)
        if not active["login"]:
            if not rows or rows[0].get("run_id") != active["run_id"]:
                worker_failed()
                rows = history(root)
            business_result = next((r for r in rows if r.get("run_id") == active["run_id"]), None)
            tray.showMessage("每日开票巡检", describe(rows[0]))
            if rows[0]["outcome"] != "observed":
                action_status.setText("需要登录，数量未知；请打开目标店铺工作台后重试。" if rows[0]["outcome"] == "needs_login" else "本次检查失败，数量未知；请查看下方运行日志。")
                log_panel.toggle.setChecked(True)
        level, message = process_result(business_result, worker.exitCode(), connect=active["login"], timed_out=active["timed_out"])
        append_log(root, level, "任务结束", message, run_id=active["run_id"])
        log_panel.refresh()

    worker.finished.connect(finished)
    def process_error(error):
        append_log(root, "ERROR", "子进程错误", f"进程错误类型 {error.name}；请检查 Python、PySide6 与客户端环境。", run_id=active["run_id"], code="PROCESS_ERROR")
        if not active["login"]:
            worker_failed()
        else:
            action_status.setText("客户端连接子进程失败，请查看运行日志。")
        watchdog.stop()
        log_panel.toggle.setChecked(True)
        log_panel.refresh()
    worker.errorOccurred.connect(process_error)
    menu = QMenu()
    show_action = QAction("打开巡检窗口", menu)
    show_action.triggered.connect(window.showNormal)
    menu.addAction(show_action)
    quit_action = QAction("退出并停止定时任务", menu)
    def quit_monitor():
        if worker.state() != QProcess.NotRunning:
            QMessageBox.information(window, "正在运行", "请等待本次客户端检查结束，再退出。")
            return
        window.quitting = True
        app.quit()
    quit_action.triggered.connect(quit_monitor)
    menu.addAction(quit_action)
    tray.setContextMenu(menu)
    tray.activated.connect(lambda reason: window.showNormal() if reason == QSystemTrayIcon.DoubleClick else None)
    tray.show()
    save_config(root, settings)
    append_log(root, "INFO", "程序启动", "本地巡检程序已启动；旧历史保留，不补造旧版详细日志。")
    refresh()
    window.show()
    QTimer.singleShot(1000, tick)
    return app.exec()


def main(argv=None):
    parser = argparse.ArgumentParser(description="本地每日巡检：程序内定时、已登录千牛客户端检查和历史记录。")
    parser.add_argument("--data-dir", type=Path, default=default_root())
    parser.add_argument("--run-id", help="内部诊断任务编号")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("show", help="打开巡检历史窗口")
    sub.add_parser("history", help="输出最近检查记录")
    sub.add_parser("check", help="直接读取已登录千牛客户端，执行一次只读检查")
    sub.add_parser("connect", help="连接当前千牛账号，自动读取账号ID")
    sub.add_parser("login", help="兼容旧入口：连接已登录千牛，不打开浏览器")
    observe = sub.add_parser("record", help="保存本次技能实时读取的证据，不执行后台操作")
    observe.add_argument("--shop", required=True)
    observe.add_argument("--outcome", choices=OUTCOMES, required=True)
    observe.add_argument("--pending-count", type=int)
    observe.add_argument("--unrecorded-count", type=int)
    observe.add_argument("--scope-start")
    observe.add_argument("--scope-end")
    observe.add_argument("--coverage", choices=COVERAGES, default="unknown")
    observe.add_argument("--fresh-query", action="store_true")
    observe.add_argument("--message", default="")
    args = parser.parse_args(argv)
    if args.command in (None, "show"):
        return gui(args.data_dir)
    if args.command in ("check", "connect", "login"):
        from invoice_assistant.native_watch import native_worker
        result = native_worker(args.data_dir, connect=args.command != "check", run_id=args.run_id)
        success = isinstance(result, dict) and (result.get("outcome") == "observed" if args.command == "check" else result.get("connected") is True)
        return 0 if success else 2
    if args.command == "history":
        result = history(args.data_dir)
    else:
        try:
            result = record(args.data_dir, {k: v for k, v in vars(args).items() if k not in ("command", "data_dir", "run_id")})
        except (ValueError, TypeError) as exc:
            parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
