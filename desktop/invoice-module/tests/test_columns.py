import unittest
from invoice_assistant.columns import column_map


class ColumnTests(unittest.TestCase):
    def test_exact_mapping_does_not_steal_amount(self):
        result=column_map(["买家实际支付金额","买家会员名"],"淘宝天猫")
        self.assertEqual(result["amount"],0)
        self.assertEqual(result["buyer_account"],1)

    def test_manual_column_override(self):
        result=column_map(["自定义订单","自定义申请"],"",True,{"order_no":"自定义订单","source_id":"自定义申请"})
        self.assertEqual(result,{"order_no":0,"source_id":1})

    def test_ambiguous_and_missing_columns_rejected(self):
        with self.assertRaises(ValueError):column_map(["订单号","订单号"],"",True)
        with self.assertRaises(ValueError):column_map(["订单号"],"",True,{"title":"不存在"})

    def test_duplicate_manual_mapping_rejected(self):
        with self.assertRaises(ValueError):column_map(["自定义"],"",True,{"title":"自定义","order_no":"自定义"})
