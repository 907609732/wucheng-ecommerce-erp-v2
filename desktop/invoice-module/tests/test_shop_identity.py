import json
import tempfile
import unittest
from pathlib import Path

from invoice_assistant.shop_identity import recognize, bind_recognized
from invoice_assistant.store import Store, now


class IdentityTests(unittest.TestCase):
    def snapshot(self, text="店铺名称：测试店铺\n店铺ID：123456", url="https://qn.taobao.com/shop/info?token=must-not-save"):
        return {"text":text,"url":url}

    def test_explicit_identity_and_redacted_url(self):
        found=recognize("taobao",[self.snapshot()])
        self.assertEqual(found["name"],"测试店铺")
        self.assertEqual(found["shop_id"],"123456")
        self.assertNotIn("token",found["source_url"])

    def test_multiline_labels(self):
        self.assertEqual(recognize("taobao",[self.snapshot("店铺名称\n测试店铺\n店铺 ID\n123456")])["shop_id"],"123456")

    def test_nickname_and_tax_id_are_not_shop_id(self):
        self.assertIsNone(recognize("taobao",[self.snapshot("店铺名称：测试店铺\n账号：tb123456\n税号：92330681TEST")]))

    def test_untrusted_origin_and_http_rejected(self):
        for url in ("https://taobao.com.evil.test/", "http://qn.taobao.com/", "https://mms.pinduoduo.com/"):
            self.assertIsNone(recognize("taobao",[self.snapshot(url=url)]))

    def test_login_screen_not_identity_proof(self):
        self.assertIsNone(recognize("taobao",[self.snapshot("扫码登录\n店铺名称：测试店铺\n店铺ID：123456")]))

    def test_conflicting_shops_rejected(self):
        with self.assertRaisesRegex(ValueError,"不一致"):
            recognize("taobao",[self.snapshot(),self.snapshot("店铺名称：另一店铺\n店铺ID：987654")])

    def test_conflicting_ids_in_one_page_rejected(self):
        with self.assertRaisesRegex(ValueError,"多个"):
            recognize("taobao",[self.snapshot("店铺名称：测试店铺\n店铺ID：123456\n店铺ID：987654")])

    def test_no_join_across_partial_pages(self):
        self.assertIsNone(recognize("taobao",[self.snapshot("店铺名称：测试店铺"),self.snapshot("店铺ID：123456")]))

    def test_duplicate_snapshots_are_consistent(self):
        self.assertEqual(recognize("taobao",[self.snapshot(),self.snapshot()])["shop_id"],"123456")

    def store_account(self, store, aid="a", shopid=""):
        store.execute("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)",
                      (aid,"taobao","登录后识别","",shopid,"needs_login",'{"recipe":{"keep":true}}',now()))

    def test_bind_persists_identity_not_legal_company(self):
        with tempfile.TemporaryDirectory() as folder:
            store=Store(folder);self.store_account(store)
            bind_recognized(store,"a",recognize("taobao",[self.snapshot()]))
            account=store.rows("SELECT * FROM accounts")[0]
            self.assertEqual(account["name"],"测试店铺")
            self.assertEqual(account["company"],"taobao:123456")
            self.assertEqual(account["state"],"complete")
            self.assertTrue(json.loads(account["binding"])["recipe"]["keep"])
            self.assertTrue(store.rows("SELECT * FROM audit WHERE kind='shop_identity'"))

    def test_wrong_shop_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            store=Store(folder);self.store_account(store,shopid="999")
            with self.assertRaisesRegex(ValueError,"不一致"):
                bind_recognized(store,"a",recognize("taobao",[self.snapshot()]))
            self.assertEqual(store.rows("SELECT shop_id FROM accounts")[0]["shop_id"],"999")

    def test_duplicate_shop_not_silently_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            store=Store(folder);self.store_account(store,"existing","123456");self.store_account(store)
            with self.assertRaisesRegex(ValueError,"已存在"):
                bind_recognized(store,"a",recognize("taobao",[self.snapshot()]))
            self.assertEqual(len(store.rows("SELECT * FROM accounts")),2)

    def test_login_platform_reuses_unbound_draft_without_manual_fields(self):
        from invoice_assistant.ui import Controller
        with tempfile.TemporaryDirectory() as folder:
            store=Store(folder);self.store_account(store)
            ctl=Controller(store,Path(__file__).resolve().parents[1])
            calls=[]
            ctl.launch=lambda accounts,connect_only=False:calls.append((accounts,connect_only))
            ctl.loginPlatform("taobao")
            self.assertEqual(len(store.rows("SELECT * FROM accounts")),1)
            self.assertEqual(calls[0][0][0]["id"],"a")
            self.assertTrue(calls[0][1])

    def test_real_browser_visible_text_pipeline_with_synthetic_page(self):
        # All requests fulfilled locally: this is browser integration, NOT live
        # Taobao acceptance and never uses the user's authenticated profile.
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel="chrome",headless=True)
            try:
                ctx=browser.new_context()
                ctx.route("**/*",lambda route:route.fulfill(content_type="text/html; charset=utf-8",
                          body="<html><body><p>店铺名称：测试店铺</p><p>店铺ID：123456</p></body></html>"))
                page=ctx.new_page()
                page.goto("https://qn.taobao.com/synthetic-identity-test")
                found=recognize("taobao",[{"url":frame.url,"text":frame.locator("body").inner_text()} for frame in page.frames])
                self.assertEqual(found["shop_id"],"123456")
                self.assertEqual(found["name"],"测试店铺")
            finally:
                browser.close()

    def test_collector_first_login_needs_no_manual_binding(self):
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        from invoice_assistant.collector import TaobaoAdapter
        page=Mock()
        page.url="https://qn.taobao.com/shop/info"
        frame=Mock();frame.url=page.url
        frame.locator.return_value.inner_text.return_value="店铺名称：测试店铺\n店铺ID：123456"
        page.frames=[frame]
        ctx=Mock();ctx.pages=[page]
        pw=SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=Mock(return_value=ctx)))
        events=[]
        with tempfile.TemporaryDirectory() as folder, patch("playwright.sync_api.sync_playwright") as factory:
            factory.return_value.__enter__.return_value=pw
            adapter=TaobaoAdapter({"id":"test","platform":"taobao","shop_id":"","binding":"{}"},
                                  folder,lambda kind,**payload:events.append({"kind":kind,**payload}))
            self.assertIsNone(adapter.collect(connect_only=True))
        connected=[e for e in events if e["kind"]=="connected"]
        self.assertEqual(connected[0]["identity"]["shop_id"],"123456")
        ctx.close.assert_called_once()


if __name__=="__main__":unittest.main()
