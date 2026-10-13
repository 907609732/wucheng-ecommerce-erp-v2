from datetime import datetime, timezone, timedelta
import tempfile
import unittest
from invoice_assistant.watch_runtime import config, save_config, claim_due, next_due, parse_count


class LocalScheduleTests(unittest.TestCase):
    def now(self, day=11, hour=20, minute=0):
        return datetime(2026, 10, day, hour, minute, tzinfo=timezone(timedelta(hours=8)))

    def test_default_time_and_pause(self):
        with tempfile.TemporaryDirectory() as root:
            settings = config(root)
            self.assertEqual(settings["time"], "20:00")
            self.assertFalse(claim_due(root, settings, self.now(hour=19, minute=59)))
            settings["enabled"] = False
            self.assertFalse(claim_due(root, settings, self.now()))

    def test_restart_and_sleep_catchup_once(self):
        with tempfile.TemporaryDirectory() as root:
            settings = config(root)
            self.assertTrue(claim_due(root, settings, self.now(hour=21)))
            self.assertFalse(claim_due(root, config(root), self.now(hour=22)))
            self.assertTrue(claim_due(root, settings, self.now(day=12)))

    def test_setting_persistence_and_next(self):
        with tempfile.TemporaryDirectory() as root:
            settings = config(root)
            settings["time"] = "21:30"
            save_config(root, settings)
            self.assertEqual(config(root)["time"], "21:30")
            self.assertEqual(next_due(settings, self.now()), "2026-10-11 21:30")
            self.assertEqual(next_due(settings, self.now(hour=22)), "2026-10-12 21:30")

    def test_real_total_required(self):
        self.assertEqual(parse_count("共计 1 条记录"), 1)
        self.assertEqual(parse_count("共计0条申请"), 0)
        for body in ("页面加载失败", "共计1条记录 共计2条记录", "待录入开票0"):
            with self.assertRaises(ValueError):
                parse_count(body)


if __name__ == "__main__":
    unittest.main()
