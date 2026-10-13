"""New application entry. Legacy run.py and gui.py are intentionally retained."""
from __future__ import annotations
import argparse
import json
import os
import sys
from console_bridge import install_console_bridge
install_console_bridge()
from pathlib import Path

BASE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker")
    parser.add_argument("--execution-worker")
    parser.add_argument("--demo",action="store_true")
    parser.add_argument("--data-dir")
    parser.add_argument("--check",action="store_true")
    parser.add_argument("--check-report")
    parser.add_argument("--screenshot")
    parser.add_argument("--page",choices=["start","history","settings"],default="start")
    parser.add_argument("--step",type=int,choices=range(1,6),help="打开流程第1至5步（仅导航，不执行业务操作）")
    parser.add_argument("--show-login",action="store_true",help="显示平台选择弹窗，不自动登录")
    parser.add_argument("--connect",choices=["jushuitan","pinduoduo","taobao","jd"])
    args = parser.parse_args()
    if args.worker or args.execution_worker:
        from invoice_assistant.worker_streams import ensure_worker_streams
        ensure_worker_streams()
    if args.execution_worker:
        from invoice_assistant.execution import worker
        worker(args.execution_worker)
        return
    if args.worker:
        from invoice_assistant.collector import worker
        worker(args.worker)
        return
    if args.check:
        from invoice_assistant.diagnostics import check
        report=json.dumps(check(),ensure_ascii=False,indent=2)
        if args.check_report:Path(args.check_report).write_text(report,encoding="utf-8")
        if sys.stdout is not None:print(report)
        return
    from PySide6.QtCore import QUrl, QTimer, QLockFile
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuick import QQuickWindow
    from PySide6.QtQuickControls2 import QQuickStyle
    QQuickStyle.setStyle("Basic")
    from invoice_assistant.store import Store
    from invoice_assistant.migration import migrate
    from invoice_assistant.ui import Controller
    root = Path(args.data_dir) if args.data_dir else Path(os.environ.get("LOCALAPPDATA",str(Path.home()/"AppData"/"Local"))) / "WuchengInvoiceAssistant" / "Runtime"
    if args.demo and not args.data_dir:
        import tempfile
        root=Path(tempfile.mkdtemp(prefix="invoice-mock-demo-"))
    root.mkdir(parents=True,exist_ok=True)
    app = QGuiApplication(sys.argv)
    app.setOrganizationName("Wucheng")
    app.setApplicationName("InvoiceAssistant")
    lock = QLockFile(str(root/"application.lock"))
    if not lock.tryLock(100):
        print("开票助手已运行，请切换到已有窗口")
        return
    store = Store(root)
    if args.demo:
        from invoice_assistant.templates import register
        from invoice_assistant.demo import create_demo
        register(store,"xinfutong",BASE/"模板"/"新福通通用开票申请单模板.xlsx")
        create_demo(store)
    else:
        from runtime_paths import legacy_data_root
        legacy = legacy_data_root()
        migrate(store, legacy if (legacy / "config.yaml").exists() else BASE)
        # 模板随模块发布；不依赖将被删除的旧工作区。
        if not store.rows("SELECT target FROM templates WHERE target='xinfutong'"):
            from invoice_assistant.templates import register
            register(store, "xinfutong", BASE / "模板" / "新福通通用开票申请单模板.xlsx")
    ctl = Controller(store,BASE)
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("backend",ctl)
    engine.load(QUrl.fromLocalFile(str(BASE/"invoice_assistant"/"Main.qml")))
    if not engine.rootObjects():
        raise SystemExit(1)
    engine.rootObjects()[0].setProperty("page",["start","history","settings"].index(args.page))
    if args.step is not None:
        engine.rootObjects()[0].setProperty("flowStep",args.step-1)
    if args.show_login:
        from PySide6.QtCore import QMetaObject
        QMetaObject.invokeMethod(engine.rootObjects()[0],"showLoginDialog")
    if args.connect:
        from invoice_assistant.store import uid, now
        rows = store.rows("SELECT * FROM accounts WHERE platform=?",(args.connect,))
        if not rows:
            aid=uid()
            store.execute("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)",(aid,args.connect,"聚水潭（待确认绑定）","","","needs_binding","{}",now()))
        else:aid=rows[0]["id"]
        ctl.refresh()
        engine.rootObjects()[0].setProperty("page",2)
        QTimer.singleShot(700,lambda:ctl.connectAccount(aid))
    app.aboutToQuit.connect(ctl.shutdown)
    if args.screenshot:
        def capture():
            engine.rootObjects()[0].grabWindow().save(args.screenshot)
            app.quit()
        QTimer.singleShot(1800,capture)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
