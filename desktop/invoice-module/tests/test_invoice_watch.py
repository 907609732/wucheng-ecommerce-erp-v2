import tempfile
import unittest
from invoice_watch import record, history, validate_observation, describe, process_result


class InvoiceWatchTests(unittest.TestCase):
    def test_process_exit_zero_is_not_business_success(self):
        for result in (None, {"outcome": "error"}, {"connected": False}):
            level, message = process_result(result, 0)
            self.assertEqual(level, "ERROR")
            self.assertIn("检查失败", message)
        self.assertIn("需要登录", process_result({"outcome": "needs_login"}, 2)[1])
        self.assertEqual(process_result({"outcome": "observed"}, 0)[0], "INFO")
        self.assertEqual(process_result({"connected": True}, 0, connect=True)[0], "INFO")

    def test_process_timeout_or_nonzero_exit_blocks_success(self):
        result = {"outcome": "observed"}
        self.assertEqual(process_result(result, 2)[0], "ERROR")
        self.assertEqual(process_result(result, 0, timed_out=True)[0], "ERROR")
        self.assertIn("超过运行时限", process_result(result, 0, timed_out=True)[1])

    def observation(self, **overrides):
        return {"shop": "测试店", "outcome": "observed", "pending_count": 0,
                "unrecorded_count": 1, "scope_start": "2026-01-01", "scope_end": "2026-01-02",
                "coverage": "visible_range", "fresh_query": True, **overrides}

    def test_unrecorded_is_attention_not_issued(self):
        row = validate_observation(self.observation())
        self.assertEqual(row["state"], "attention")
        self.assertIn("待录入不等于尚未开具", describe(row))

    def test_partial_zero_is_not_clear(self):
        self.assertEqual(validate_observation(self.observation(unrecorded_count=0))["state"], "partial")

    def test_verified_platform_range_zero_is_clear(self):
        self.assertEqual(validate_observation(self.observation(unrecorded_count=0, coverage="platform_available_range"))["state"], "clear")

    def test_login_failure_counts_remain_unknown(self):
        row = validate_observation(self.observation(outcome="needs_login", pending_count=None, unrecorded_count=None, message="需要扫码"))
        self.assertIsNone(row["pending_count"])
        self.assertEqual(row["coverage"], "unknown")

    def test_invalid_evidence_rejected(self):
        for changes in ({"fresh_query": False}, {"pending_count": -1}, {"pending_count": True},
                        {"unrecorded_count": None}, {"scope_start": "bad"}, {"shop": " "},
                        {"scope_end": "2099-01-01"}, {"coverage": "unknown"},
                        {"outcome": "error", "message": "断网"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_observation(self.observation(**changes))

    def test_history_persists_separately_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as root:
            first = record(root, self.observation())
            failed = record(root, self.observation(outcome="error", pending_count=None, unrecorded_count=None, message="读取失败"))
            rows = history(root)
            self.assertEqual([r["id"] for r in rows], [failed["id"], first["id"]])
            self.assertEqual(rows[0]["state"], "error")


if __name__ == "__main__":
    unittest.main()
