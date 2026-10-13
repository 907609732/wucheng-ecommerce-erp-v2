"""Render the real QML without browser access or business mutations."""
import tempfile
import unittest
from pathlib import Path

from PySide6.QtCore import QUrl, qInstallMessageHandler
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle

from invoice_assistant.store import Store, now
from invoice_assistant.ui import Controller


class NavigationTests(unittest.TestCase):
    def test_five_steps_and_secondary_pages_render_without_business_actions(self):
        QQuickStyle.setStyle("Basic")
        app = QGuiApplication.instance() or QGuiApplication([])
        errors = []
        old_handler = qInstallMessageHandler(lambda kind, context, message: errors.append(message))
        try:
            with tempfile.TemporaryDirectory() as folder:
                store = Store(Path(folder))
                store.execute("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)",
                              ("ui-test", "taobao", "测试店铺", "测试公司", "test-shop",
                               "needs_login", "{}", now()))
                base = Path(__file__).resolve().parents[1]
                ctl = Controller(store, base)
                engine = QQmlApplicationEngine()
                engine.rootContext().setContextProperty("backend", ctl)
                engine.load(QUrl.fromLocalFile(str(base / "invoice_assistant" / "Main.qml")))
                self.assertTrue(engine.rootObjects(), errors)
                win = engine.rootObjects()[0]
                self.assertEqual(win.property("flowStep"), 0)
                for width, height in [(1220, 850), (1000, 720)]:
                    win.setWidth(width)
                    win.setHeight(height)
                    for page in range(3):
                        win.setProperty("page", page)
                        for step in range(5):
                            win.setProperty("flowStep", step)
                            app.processEvents()
                            self.assertFalse(win.grabWindow().isNull())
                self.assertEqual(store.rows("SELECT * FROM batches"), [])
                self.assertEqual(store.rows("SELECT * FROM execution_tasks"), [])
                self.assertEqual(store.rows("SELECT * FROM invoices"), [])
                win.close()
                ctl.shutdown()
                engine.deleteLater()
                app.processEvents()
            failures = [m for m in errors if any(word in m for word in
                        ("Error:", "Binding loop", "Cannot assign", "is not defined"))]
            self.assertEqual(failures, [])
        finally:
            qInstallMessageHandler(old_handler)
