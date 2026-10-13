import unittest
from invoice_assistant.domain import validate
from invoice_assistant.eligibility import eligibility_issues
from tests import test_v2 as fixtures
request = fixtures.request


class PlatformEligibilityTests(unittest.TestCase):
    def codes(self, **values):
        return {i["code"] for i in eligibility_issues(request(**values))}

    def test_blank_unknown_and_review_never_pending(self):
        for status in ("", "unknown", "待审核", "待处理", "开票中", "开票失败"):
            with self.subTest(status=status):
                self.assertIn("status", self.codes(platform="taobao", status=status))

    def test_jushuitan_blocked_even_explicit_pending(self):
        self.assertIn("source_eligibility", self.codes(platform="jushuitan", status="待开票"))
        self.assertIn("source_eligibility", self.codes(source_system="jushuitan"))

    def test_taobao_waiting_upload_requires_external_check(self):
        self.assertIn("external_invoice_check", self.codes(platform="taobao", status="待录入开票"))
        self.assertNotIn("external_invoice_check", self.codes(platform="taobao", status="待录入开票", external_invoice_checked=True))
        self.assertIn("external_invoice_check", self.codes(platform="taobao", status="待录入开票", external_invoice_checked="true"))

    def test_invoice_number_cannot_be_overridden_by_check(self):
        self.assertIn("source_issued", self.codes(platform="taobao", status="待录入开票", external_invoice_checked=True,source_invoice_no="123"))

    def test_refund_is_blocked(self):
        self.assertIn("refund", self.codes(refund_status="退款成功"))

    def test_platform_statuses(self):
        for platform in ("taobao", "pinduoduo", "jd"):
            self.assertFalse(self.codes(platform=platform, status="待开票"))
        self.assertIn("status", self.codes(platform="jd", status="待录入开票"))

    def test_missing_status_never_defaults_to_pending(self):
        raw=request();raw.pop("status")
        _, issues=validate(raw,{}, {"seller":{"name":"测试"}})
        self.assertIn("status", {i["code"] for i in issues})


class PlatformWorkflowTests(unittest.TestCase):
    setUp = fixtures.V2Tests.setUp
    tearDown = fixtures.V2Tests.tearDown

    def platform_files(self, status="待录入开票", invoice_no="", shop_id="123"):
        import csv
        from pathlib import Path
        folder=Path(self.temp.name)
        applications=folder/"淘宝申请.csv"
        details=folder/"淘宝商品明细.csv"
        with applications.open("w",encoding="utf-8-sig",newline="") as f:
            w=csv.writer(f)
            w.writerow(["申请单号","订单编号","申请时间","抬头类型","发票抬头","纳税人识别号","发票金额","发票状态","发票号码","店铺ID"])
            w.writerow(["app1","order1","2026-10-01 10:00","单位","测试买家","91330000TEST000001","101.00",status,invoice_no,shop_id])
        with details.open("w",encoding="utf-8-sig",newline="") as f:
            w=csv.writer(f)
            w.writerow(["订单编号","宝贝标题","销售属性","购买数量","买家实际支付金额","商家编码"])
            w.writerow(["order1","商品A","大号","2","101.00","sku1"])
        return [str(applications),str(details)]

    def parse(self, paths):
        from invoice_assistant.engine import parse_recovery_files
        return parse_recovery_files(paths,{"id":"account","platform":"taobao","name":"测试店","shop_id":"123","company":"测试公司"})

    def test_taobao_files_join_and_preserve_status(self):
        rows=self.parse(self.platform_files())
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["status"],"待录入开票")
        self.assertTrue(rows[0]["collection_complete"])
        self.assertEqual(rows[0]["items"][0]["amount"],"101.00")

    def test_source_invoice_number_preserved(self):
        rows=self.parse(self.platform_files(invoice_no="01234567890123456789"))
        self.assertEqual(rows[0]["source_invoice_no"],"01234567890123456789")
        self.assertIn("source_issued",{i["code"] for i in eligibility_issues(rows[0])})

    def test_successful_application_excluded(self):
        self.assertEqual(self.parse(self.platform_files(status="开票成功")),[])

    def test_foreign_shop_rejected(self):
        with self.assertRaisesRegex(ValueError,"店铺ID"):
            self.parse(self.platform_files(shop_id="999"))

    def test_blank_status_not_promoted_from_file(self):
        rows=self.parse(self.platform_files(status=""))
        self.assertIn("status",{i["code"] for i in eligibility_issues(rows[0])})
    def test_taobao_check_per_request_audited(self):
        from invoice_assistant.domain import identity
        r=request(platform="taobao",status="待录入开票")
        r2=request(platform="taobao",status="待录入开票",source_id="second")
        self.engine.ingest(self.bid,[r,r2])
        self.assertEqual(self.engine.prepare(self.bid,["xinfutong"])["files"],[])
        self.engine.correct(identity(r),{"external_invoice_checked":True})
        rows={x["id"]:x for x in self.engine.requests(self.bid)}
        self.assertFalse(rows[identity(r)]["problems"])
        self.assertIn("external_invoice_check",{i["code"] for i in rows[identity(r2)]["problems"]})
        self.assertTrue(self.store.rows("SELECT * FROM audit WHERE kind='correction'"))

    def test_mapping_update_preserves_other_fields(self):
        self.store.mapping("sku","key",{"rate":"0.01","unit":"件"})
        self.store.mapping("sku","key",{"tax_code":"1090511030000000000"})
        self.assertEqual(self.engine.maps()["sku"]["key"]["unit"],"件")


if __name__ == "__main__":unittest.main()
