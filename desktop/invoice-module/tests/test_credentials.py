import unittest
from invoice_assistant.credentials import CredentialStore


class FakeVault:
    def __init__(self):self.values={}
    def set_password(self,service,reference,secret):self.values[service,reference]=secret
    def get_password(self,service,reference):return self.values.get((service,reference))


class CredentialTests(unittest.TestCase):
    def test_store_only_uses_vault_api(self):
        backend=FakeVault();store=CredentialStore(backend)
        store.save("mock-grant","synthetic-test-value")
        self.assertEqual(store.load("mock-grant"),"synthetic-test-value")
        self.assertEqual(len(backend.values),1)

    def test_empty_credentials_rejected(self):
        with self.assertRaises(ValueError):CredentialStore(FakeVault()).save("","")
