import io
import unittest
from unittest.mock import patch
from invoice_assistant.worker_streams import ensure_worker_streams


class WorkerStreamTests(unittest.TestCase):
    def test_existing_console_encoding_forced_utf8(self):
        output=io.TextIOWrapper(io.BytesIO(),encoding="gbk")
        errors=io.TextIOWrapper(io.BytesIO(),encoding="gbk")
        incoming=io.TextIOWrapper(io.BytesIO(),encoding="gbk")
        with patch("sys.stdout",output),patch("sys.stderr",errors),patch("sys.stdin",incoming):
            ensure_worker_streams()
        self.assertEqual(output.encoding,"utf-8")
        self.assertEqual(errors.encoding,"utf-8")
        self.assertEqual(incoming.encoding,"utf-8")
