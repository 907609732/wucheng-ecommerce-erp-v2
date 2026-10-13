import contextlib
import io
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
import uuid

from invoice_assistant.watch_logs import (append_log, read_logs, format_logs,
                                         safe_text, diagnostic_report, export_report)
from invoice_assistant.native_watch import native_worker, NativeCheckError
from invoice_watch import history


def verify_panel(root):
    from PySide6.QtWidgets import QApplication
    from invoice_assistant.watch_log_panel import LogPanel
    app = QApplication([])
    append_log(root, "INFO", "开始", "正在检查")
    append_log(root, "ERROR", "查询", "未找到结果", code="QUERY_PENDING")
    panel = LogPanel(Path(root))
    panel.toggle.setChecked(True)
    assert "正在检查" in panel.viewer.toPlainText()
    panel.errors.setChecked(True)
    assert "正在检查" not in panel.viewer.toPlainText()
    assert "QUERY_PENDING" in panel.viewer.toPlainText()
    panel.copy.click()
    assert "QUERY_PENDING" in app.clipboard().text()
    panel.export.click()
    assert len(list((Path(root) / "diagnostics").glob("*.txt"))) == 1
    panel.search.setText("找不到的关键词")
    assert panel.viewer.toPlainText() == ""
    panel.timer.stop()
    panel.close()


class LogTests(unittest.TestCase):
    def test_persistent_order_and_literal_keyword_filter(self):
        with tempfile.TemporaryDirectory() as root:
            run_id = uuid.uuid4().hex
            append_log(root, "INFO", "开始", "准备检查", run_id=run_id)
            append_log(root, "ERROR", "查询", "超时 100%", run_id=run_id, code="QUERY_PENDING")
            append_log(root, "WARNING", "范围", "仅当前范围")
            self.assertEqual([r["level"] for r in read_logs(root)], ["INFO", "ERROR", "WARNING"])
            self.assertEqual(len(read_logs(root, errors_only=True)), 1)
            self.assertEqual(len(read_logs(root, keyword="%")), 1)
            self.assertEqual(len(read_logs(root, keyword="query_pending")), 1)
            self.assertEqual(len(read_logs(root, keyword=run_id)), 2)
            self.assertEqual(read_logs(root, keyword="不存在"), [])
            self.assertEqual(len(read_logs(root, limit=1)), 1)

    def test_redaction_and_input_validation(self):
        text = safe_text("token=secretvalue 密码：pass123 验证码=888888 税号：913300001234567890 tb12345 https://test.invalid/?token=oops")
        for secret in ("secretvalue", "pass123", "888888", "913300001234567890", "tb12345", "test.invalid", "oops"):
            self.assertNotIn(secret, text)
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                append_log(root, "UNKNOWN", "", "")
            with self.assertRaises(ValueError):
                append_log(root, "INFO", "", "", run_id="tb12345")

    def test_reports_are_local_filtered_and_do_not_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            append_log(root, "INFO", "初始化", "普通信息")
            append_log(root, "ERROR", "查询", "读取失败", code="QUERY_PENDING")
            report = diagnostic_report(root, errors_only=True)
            self.assertIn("QUERY_PENDING", report)
            self.assertNotIn("普通信息", report)
            path1 = export_report(root, errors_only=True)
            path2 = export_report(root, errors_only=True)
            self.assertNotEqual(path1, path2)
            saved = path1.read_text(encoding="utf-8-sig")
            self.assertIn("QUERY_PENDING", saved)
            self.assertNotIn("普通信息", saved)
            self.assertTrue(path1.is_relative_to(Path(root)))

    def test_worker_error_has_stage_task_type_and_safe_location(self):
        class FailedClient:
            def identity(self):
                raise RuntimeError("password=DO_NOT_STORE_THIS https://private.invalid/cookie")
        with tempfile.TemporaryDirectory() as root:
            run_id = uuid.uuid4().hex
            with contextlib.redirect_stdout(io.StringIO()):
                native_worker(root, client_factory=FailedClient, run_id=run_id)
            errors = read_logs(root, errors_only=True)
            self.assertEqual(len(errors), 1)
            self.assertEqual(errors[0]["code"], "CLIENT_IDENTITY")
            self.assertEqual(errors[0]["run_id"], run_id)
            self.assertIn("RuntimeError", errors[0]["message"])
            self.assertIn("native_watch.py:", errors[0]["message"])
            self.assertNotIn("DO_NOT_STORE_THIS", format_logs(read_logs(root)))
            self.assertNotIn("private.invalid", diagnostic_report(root))
            self.assertIsNone(history(root)[0]["pending_count"])
            self.assertEqual(history(root)[0]["run_id"], run_id)

    def test_worker_expected_error_records_actionable_message(self):
        def missing():
            raise NativeCheckError("未找到唯一的千牛客户端，请打开并登录千牛")
        with tempfile.TemporaryDirectory() as root:
            with contextlib.redirect_stdout(io.StringIO()):
                native_worker(root, client_factory=missing)
            row = read_logs(root, errors_only=True)[0]
            self.assertEqual(row["code"], "CLIENT_WINDOW")
            self.assertIn("请打开并登录千牛", row["message"])

    def test_panel_filter_copy_and_export(self):
        # QML tests own a QGuiApplication; Widgets must own QApplication in a
        # separate process, not reuse or upgrade that existing singleton.
        with tempfile.TemporaryDirectory() as root:
            environment = dict(os.environ, QT_QPA_PLATFORM="offscreen")
            script = "import runpy,sys; runpy.run_path(sys.argv[1])['verify_panel'](sys.argv[2])"
            result = subprocess.run([sys.executable, "-c", script, str(Path(__file__).resolve()), root],
                                    env=environment, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
