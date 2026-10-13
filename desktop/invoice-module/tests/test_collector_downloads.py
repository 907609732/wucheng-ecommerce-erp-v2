import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, MagicMock

from invoice_assistant.collector import CollectionError, MerchantAdapter


class CollectorDownloadTests(unittest.TestCase):
    def test_legacy_separate_layout_remains_default(self):
        self.assertEqual(MerchantAdapter.export_kinds({
            "request_export": "导出申请", "detail_export": "导出明细"
        }), ("request_export", "detail_export"))

    def test_combined_layout_needs_only_one_button(self):
        self.assertEqual(MerchantAdapter.export_kinds({
            "export_layout": "combined", "request_export": "导出"
        }), ("request_export",))

    def test_unknown_layout_and_missing_button_fail_closed(self):
        for recipe in ({"export_layout": "guess"},
                       {"export_layout": "combined"},
                       {"request_export": "导出申请"},
                       {"export_layout": "combined", "request_export": " "}):
            with self.subTest(recipe=recipe), self.assertRaises(CollectionError):
                MerchantAdapter.export_kinds(recipe)

    def test_combined_download_clicks_once_and_preserves_existing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter = MerchantAdapter({"platform": "taobao"}, folder)
            adapter.click_text = Mock(return_value=True)
            download = Mock()
            download.suggested_filename = "平台导出.xlsx"
            download.failure.return_value = None
            page = MagicMock()
            page.expect_download.return_value.__enter__.return_value = SimpleNamespace(value=download)
            page.expect_download.return_value.value = download
            recipe = {"export_layout": "combined", "request_export": "导出"}
            paths = adapter.download_files(page, recipe)
            self.assertEqual(len(paths), 1)
            adapter.click_text.assert_called_once_with(page, ["导出"])
            download.save_as.assert_called_once()
            Path(paths[0]).touch()
            with self.assertRaises(CollectionError):
                adapter.download_files(page, recipe)
            self.assertEqual(download.save_as.call_count, 1)

    def test_download_failure_does_not_save(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter = MerchantAdapter({"platform": "taobao"}, folder)
            adapter.click_text = Mock(return_value=True)
            download = Mock()
            download.failure.return_value = "network interrupted"
            page = MagicMock()
            page.expect_download.return_value.__enter__.return_value = SimpleNamespace(value=download)
            page.expect_download.return_value.value = download
            with self.assertRaises(CollectionError):
                adapter.download_files(page, {"export_layout": "combined", "request_export": "导出"})
            download.save_as.assert_not_called()


if __name__ == "__main__":
    unittest.main()
