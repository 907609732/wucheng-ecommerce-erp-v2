"""Private invoice data paths, independent from the ERP database and source tree."""
import os
from pathlib import Path


def legacy_data_root():
    return Path(os.environ.get("WUCHENG_INVOICE_LEGACY_DATA") or
                Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) /
                "WuchengInvoiceAssistant" / "Legacy")
