import contextlib
import io
import tempfile
import unittest
from unittest.mock import patch, Mock
from invoice_assistant.native_watch import account_from_names, invoice_url, parse_total, native_worker, NativeCheckError, NativeAmbiguityError, NativeLoginRequiredError, QianniuClient, finance_target, select_client_window
from types import SimpleNamespace
from invoice_assistant.watch_runtime import config, save_config
from invoice_watch import history, main


class FakeClient:
    def identity(self): return "tb12345"
    def navigate(self): pass
    def query(self, tab, expected):
        return (0 if tab == "待处理申请" else 1), ["2026-08-11", "2026-10-11"]


class NativeWatchTests(unittest.TestCase):
    @staticmethod
    def window(title="千牛工作台", pid=1):
        return SimpleNamespace(window_text=lambda: title, process_id=lambda: pid)

    def test_window_discovery_rejects_wrong_process_and_multiple_workbenches(self):
        good, wrong = self.window(pid=1), self.window(pid=2)
        paths = {1: r"D:\Program Files\AliWorkbench.exe", 2: r"C:\other.exe"}
        self.assertIs(select_client_window([good, wrong, self.window("悬浮条")], paths.__getitem__), good)
        with self.assertRaises(NativeAmbiguityError) as caught:
            select_client_window([good, self.window()], paths.__getitem__)
        self.assertEqual(caught.exception.code, "CLIENT_MULTIPLE")

    def test_login_window_does_not_override_existing_background_workbench(self):
        main, login = self.window(), self.window("千牛登录")
        self.assertIs(select_client_window([login, main], lambda _: r"D:\AliWorkbench.exe"), main)
        with self.assertRaises(NativeLoginRequiredError) as caught:
            select_client_window([login], lambda _: r"D:\AliWorkbench.exe")
        self.assertEqual(caught.exception.code, "CLIENT_LOGIN")

    def test_duplicate_titles_resolve_only_by_explicit_account_identity(self):
        windows = [self.window(pid=i) for i in range(3)]
        accounts = {0: None, 1: "tb123", 2: "tb456"}
        def identify(window):
            value = accounts[window.process_id()]
            if value is None: raise NativeCheckError("unreadable host")
            return value
        path = lambda _: r"D:\AliWorkbench.exe"
        self.assertIs(select_client_window(windows, path, identify=identify, expected_account="tb123"), windows[1])
        for expected in (None, "tb999"):
            with self.assertRaises(NativeAmbiguityError):
                select_client_window(windows, path, identify=identify, expected_account=expected)
        accounts[2] = "tb123"
        with self.assertRaises(NativeAmbiguityError):
            select_client_window(windows, path, identify=identify, expected_account="tb123")

    def test_unreadable_duplicate_titles_never_trigger_restore(self):
        windows = [self.window(), self.window()]
        def unreadable(_): raise RuntimeError("private content")
        with self.assertRaises(NativeAmbiguityError) as caught:
            select_client_window(windows, lambda _: r"D:\AliWorkbench.exe", identify=unreadable, expected_account="tb123")
        self.assertEqual(caught.exception.code, "CLIENT_MULTIPLE")
        self.assertNotIn("private content", str(caught.exception))

    def test_missing_window_and_unverified_owner_are_distinct(self):
        with self.assertRaises(NativeCheckError) as caught:
            select_client_window([], lambda _: "unused")
        self.assertEqual(caught.exception.code, "CLIENT_MISSING")
        def denied(_): raise PermissionError("token=do-not-log")
        with self.assertRaises(NativeCheckError) as caught:
            select_client_window([self.window()], denied)
        self.assertEqual(caught.exception.code, "CLIENT_OWNER")
        self.assertNotIn("do-not-log", str(caught.exception))

    def test_minimized_or_hidden_window_is_discovered_before_uia_and_restored(self):
        for minimized, hidden in ((True, False), (False, True), (False, False)):
            with self.subTest(minimized=minimized, hidden=hidden):
                native = Mock(handle=123)
                native.window_text.return_value = "千牛工作台"
                native.is_minimized.return_value = minimized
                native.is_visible.side_effect = [False, True] if hidden else None
                if not hidden: native.is_visible.return_value = True
                win32, uia, target = Mock(), Mock(), Mock()
                win32.windows.return_value = [native]
                uia.window.return_value.wrapper_object.return_value = target
                with patch("pywinauto.Desktop", side_effect=[win32, uia]), patch("win32api.OpenProcess"), patch("win32process.GetModuleFileNameEx", return_value=r"D:\AliWorkbench.exe"):
                    client = QianniuClient()
                self.assertFalse(win32.windows.call_args.kwargs["visible_only"])
                self.assertEqual(native.restore.call_count, int(minimized or hidden))
                uia.window.assert_called_once_with(handle=123)
                self.assertIs(client.window, target)
                target.set_focus.assert_called_once()

    def test_hidden_window_that_cannot_be_restored_stops_before_uia(self):
        native = Mock()
        native.window_text.return_value = "千牛工作台"
        native.is_minimized.return_value = False
        native.is_visible.return_value = False
        desktop = Mock()
        desktop.windows.return_value = [native]
        with patch("pywinauto.Desktop", return_value=desktop), patch("win32api.OpenProcess"), patch("win32process.GetModuleFileNameEx", return_value=r"D:\AliWorkbench.exe"), self.assertRaises(NativeCheckError) as caught:
            QianniuClient()
        self.assertEqual(caught.exception.code, "CLIENT_HIDDEN")
        desktop.window.assert_not_called()

    def test_login_handoff_is_recorded_with_unknown_counts(self):
        def login():
            raise NativeLoginRequiredError("请手动登录", "CLIENT_LOGIN")
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()):
            result = native_worker(root, client_factory=login)
            self.assertEqual(result["outcome"], "needs_login")
            self.assertEqual(result["error_code"], "CLIENT_LOGIN")
            self.assertIsNone(result["pending_count"])
            self.assertEqual(history(root)[0]["state"], "needs_login")

    def test_account_is_not_shop_id(self):
        self.assertEqual(account_from_names(["千牛工作台", "tb12345:员工-千牛工作台"]), "tb12345")
        for names in ([], ["tb12345"], ["tb1-千牛工作台", "tb2-千牛工作台"]):
            with self.assertRaises(NativeCheckError): account_from_names(names)

    def test_trusted_document(self):
        self.assertTrue(invoice_url("https://qn.taobao.com/home.htm/merchant-invoice/"))
        self.assertTrue(invoice_url("https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/agreed"))
        self.assertFalse(invoice_url("https://evil.test/home.htm/merchant-invoice/#/invoice/agreed"))
        self.assertFalse(invoice_url("https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/success"))

    def test_total_not_selected_count(self):
        self.assertEqual(parse_total(["共计", "1", "条记录，已选中", "0", "张发票"]), 1)
        self.assertEqual(parse_total(["共计", "0", "条申请，已选中", "0"]), 0)
        with self.assertRaises(NativeCheckError): parse_total(["待录入开票0"])

    def run_worker(self, root, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            native_worker(root, **kwargs)

    def test_connect_then_check_without_browser(self):
        with tempfile.TemporaryDirectory() as root:
            self.run_worker(root, connect=True, client_factory=FakeClient)
            self.assertEqual(config(root)["native_account"], "tb12345")
            self.assertEqual(history(root), [])
            self.run_worker(root, client_factory=FakeClient)
            row = history(root)[0]
            self.assertEqual(row["source"], "qianniu_client")
            self.assertEqual(row["state"], "attention")
            self.assertEqual(row["unrecorded_count"], 1)

    def test_unbound_and_mismatched_account_block_before_query(self):
        class NoQuery(FakeClient):
            def query(self, *_): raise AssertionError("must not query other account")
        with tempfile.TemporaryDirectory() as root:
            self.run_worker(root, client_factory=NoQuery)
            self.assertEqual(history(root)[0]["state"], "error")
            settings = config(root)
            settings["native_account"] = "tb999"
            save_config(root, settings)
            self.run_worker(root, client_factory=NoQuery)
            self.assertIsNone(history(root)[0]["pending_count"])

    def test_partial_query_failure_never_reports_zero(self):
        class Failed(FakeClient):
            def query(self, tab, expected):
                if tab == "待录入开票": raise NativeCheckError("读取超时")
                return super().query(tab, expected)
        with tempfile.TemporaryDirectory() as root:
            self.run_worker(root, connect=True, client_factory=FakeClient)
            self.run_worker(root, client_factory=Failed)
            row = history(root)[0]
            self.assertEqual(row["coverage"], "unknown")
            self.assertIsNone(row["pending_count"])

    def test_cli_uses_native_worker(self):
        with patch("invoice_assistant.native_watch.native_worker", return_value={"outcome": "observed"}) as worker:
            self.assertEqual(main(["check"]), 0)
            self.assertFalse(worker.call_args.kwargs["connect"])
            worker.return_value = {"connected": True}
            self.assertEqual(main(["connect"]), 0)
            self.assertTrue(worker.call_args.kwargs["connect"])
            for result in ({"outcome": "error"}, {"outcome": "needs_login"}, None):
                worker.return_value = result
                self.assertEqual(main(["check"]), 2)
                self.assertEqual(main(["connect"]), 2)

    def test_empty_state_below_viewport_is_still_readable(self):
        class Text:
            def __init__(self, name, index):
                self.name = name
                self.element_info = SimpleNamespace(runtime_id=[1, index])
            def window_text(self): return self.name
        controls = [Text(name, i) for i, name in enumerate(["共计", "0", "条申请，已选中", "0", "没有数据"])]
        client = QianniuClient.__new__(QianniuClient)
        client.document = lambda: SimpleNamespace(descendants=lambda **_: controls)
        self.assertEqual(client.snapshot()[0], 0)
        self.assertTrue(client.snapshot()[1])

    def test_document_url_uses_legacy_value_if_modern_empty(self):
        url = "https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/agreed"
        doc = SimpleNamespace(iface_value=SimpleNamespace(CurrentValue=""), legacy_properties=lambda: {"Value": url})
        self.assertEqual(QianniuClient.document_value(doc), url)

    @staticmethod
    def ocr_word(text, x, y):
        return {"words": [{"text": text, "bounding_rect": {"x": x, "y": y, "width": 28, "height": 16}}]}

    def test_finance_ocr_requires_aligned_unique_navigation(self):
        lines = [self.ocr_word("交易", 40, 200), self.ocr_word("商品", 40, 235), self.ocr_word("财务", 40, 450),
                 self.ocr_word("财务", 120, 170)]
        self.assertEqual(finance_target(lines), (54, 458))
        for invalid in ([], lines[2:], [lines[0], lines[1], self.ocr_word("财务", 120, 450)],
                        lines + [self.ocr_word("财务", 40, 490)]):
            with self.assertRaises(NativeCheckError): finance_target(invalid)

    def test_finance_ocr_handles_chinese_character_word_boundaries(self):
        lines = []
        for label, y in (("交易", 200), ("商品", 235), ("财务", 450)):
            lines.append({"words": [self.ocr_word(c, 40 + i * 14, y)["words"][0] for i, c in enumerate(label)]})
        self.assertEqual(finance_target(lines), (61, 458))

    def test_root_invoice_document_requires_real_invoice_tabs(self):
        client = QianniuClient.__new__(QianniuClient)
        root = "https://qn.taobao.com/home.htm/merchant-invoice/"
        tabs = []
        doc = SimpleNamespace(iface_value=SimpleNamespace(CurrentValue=root), is_visible=lambda: True,
                              descendants=lambda **_: [SimpleNamespace(window_text=lambda value=value: value) for value in tabs])
        client.window = SimpleNamespace(descendants=lambda **_: [doc])
        with self.assertRaises(NativeCheckError): client.document()
        tabs.extend(["待处理申请 0", "待录入开票 1"])
        self.assertIs(client.document(), doc)

    def test_existing_invoice_document_does_not_open_navigation(self):
        client = QianniuClient.__new__(QianniuClient)
        client.identity = lambda: "tb12345"
        document = object()
        client.document = lambda: document
        client.open_finance = lambda: self.fail("must not open finance")
        self.assertIs(client.navigate(), document)

    def test_missing_entry_opens_finance_then_invoice_and_waits(self):
        client = QianniuClient.__new__(QianniuClient)
        state = {"finance": False, "invoice": False, "stages": []}
        client.identity = lambda: "tb12345"
        def document():
            if not state["invoice"]: raise NativeCheckError("missing document")
            return "verified-document"
        client.document = document
        client.open_finance = lambda: state.update(finance=True)
        link = SimpleNamespace(click_input=lambda: state.update(invoice=True))
        client.invoice_entry = lambda: link if state["finance"] else None
        client.navigation_progress = state["stages"].append
        self.assertEqual(client.navigate(), "verified-document")
        self.assertTrue(state["finance"])
        self.assertIn("等待财务导航加载", state["stages"])

    def test_ambiguous_invoice_document_never_opens_finance(self):
        client = QianniuClient.__new__(QianniuClient)
        client.identity = lambda: "tb12345"
        def ambiguous(): raise NativeAmbiguityError("two documents")
        client.document = ambiguous
        client.open_finance = lambda: self.fail("must stop, not navigate")
        with self.assertRaises(NativeAmbiguityError): client.navigate()

    def test_navigation_account_change_stops_before_invoice_click(self):
        client = QianniuClient.__new__(QianniuClient)
        state = {"identity": "tb12345", "finance": False}
        client.identity = lambda: state["identity"]
        def missing(): raise NativeCheckError("missing document")
        client.document = missing
        link = SimpleNamespace(click_input=lambda: self.fail("must not click other account"))
        client.invoice_entry = lambda: link if state["finance"] else None
        client.open_finance = lambda: state.update(identity="tb999", finance=True)
        # One attempt makes failure fast without changing production timeouts.
        client.wait = lambda fn: fn()
        with self.assertRaises(NativeCheckError): client.navigate()

    def test_invoice_entry_checks_exact_destination_and_ambiguity(self):
        client = QianniuClient.__new__(QianniuClient)
        def link(url):
            return SimpleNamespace(window_text=lambda: "给买家开票", is_visible=lambda: True,
                                   iface_value=SimpleNamespace(CurrentValue=url), legacy_properties=lambda: {"Value": url})
        good = link("https://qn.taobao.com/home.htm/merchant-invoice/")
        client.window = SimpleNamespace(descendants=lambda **_: [good])
        self.assertIs(client.invoice_entry(), good)
        client.window = SimpleNamespace(descendants=lambda **_: [link("https://evil.invalid/home.htm/merchant-invoice/")])
        with self.assertRaises(NativeCheckError): client.invoice_entry()
        client.window = SimpleNamespace(descendants=lambda **_: [good, good])
        with self.assertRaises(NativeAmbiguityError): client.invoice_entry()


if __name__ == "__main__": unittest.main()
