"""Optional integration grants go to Windows Credential Manager, never SQLite/config/logs."""
import sys


class CredentialStore:
    def __init__(self,backend=None):
        if backend is None:
            if sys.platform!="win32":raise RuntimeError("敏感授权仅支持 Windows 安全凭据存储")
            from keyring.backends.Windows import WinVaultKeyring
            backend=WinVaultKeyring()
        self.backend=backend
        self.service="WuchengInvoiceAssistant"

    def save(self,reference,secret):
        if not reference or not secret:raise ValueError("授权引用和内容不能为空")
        self.backend.set_password(self.service,reference,secret)

    def load(self,reference):return self.backend.get_password(self.service,reference)
