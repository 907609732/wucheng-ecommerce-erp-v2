"""Linux/root-only integration: synthetic old/new owners, no NAS or real data."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'deploy/fnos/wuchengerp/cmd/retained_recovery.py'


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'requires Linux root (isolated CI)')
class Recovery(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='fnos-recovery-', dir='/root'))
        self.addCleanup(shutil.rmtree, self.root)
        self.volume = self.root / 'volume'
        self.base = self.volume / '@wuchengerp-data'
        self.data = self.base / 'erp'
        (self.data / 'state').mkdir(parents=True)
        (self.data / 'originals').mkdir()
        (self.data / 'originals' / 'bill').write_bytes(b'original bytes')
        versions = self.data / 'data-version'
        versions.mkdir()
        (versions / 'blob').write_bytes(b'immutable snapshot asset')
        os.link(versions / 'blob', versions / 'event-attachment')
        db = sqlite3.connect(self.data / 'state' / 'month-admin.sqlite')
        db.execute('CREATE TABLE credentials(record TEXT)')
        db.execute('INSERT INTO credentials VALUES(?)', ('retained password record',))
        db.commit()
        db.close()
        (self.base / 'backups' / 'retained').mkdir(parents=True)
        (self.base / 'backups' / 'retained' / 'lock.json').write_text('{"month":"2026-01"}')
        (self.base / 'erp.configure-state').mkdir(mode=0o700)
        self.outside = self.root / 'unrelated'
        self.outside.write_bytes(b'never chown')
        for p in [self.base, *self.base.rglob('*')]:
            os.chown(p, 42001, 42001)
        spec = importlib.util.spec_from_file_location('recovery', HELPER)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def recover(self):
        self.module.recover(str(self.volume), 42002, 42002)

    def test_changed_uid_retains_bytes_and_all_validated_ownership(self):
        before = {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        self.recover()
        self.assertTrue(all(p.stat().st_uid == 42002 for p in [self.base, *self.base.rglob('*')]))
        self.assertEqual(self.base.stat().st_mode & 0o777, 0o700)
        self.assertEqual({str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*') if p.is_file()}, before)
        self.assertEqual(self.outside.stat().st_uid, 0)

    def test_live_or_uncertain_records_refuse_before_any_chown(self):
        record = self.data / 'state' / 'native-supervisor.json'
        for value in [{'pid': os.getpid()}, {'pid': 'invalid'}, {'unknown': 'record'}, {'pid': 99999999, 'children': [{'pid': os.getpid()}]}]:
            record.write_text(json.dumps(value))
            with self.assertRaises(Exception):
                self.recover()
            self.assertEqual(self.base.stat().st_uid, 42001)
        record.write_text('{malformed')
        with self.assertRaises(Exception):
            self.recover()

    def test_busy_sqlite_ownership_refuses_before_chown(self):
        db = sqlite3.connect(self.data / 'state' / 'native-ownership.sqlite')
        db.execute('BEGIN EXCLUSIVE')
        try:
            with self.assertRaises(Exception):
                self.recover()
            self.assertEqual(self.base.stat().st_uid, 42001)
        finally:
            db.close()

    def test_abandoned_uuid_stage_is_preserved_without_ownership_repair(self):
        stage = self.base / 'erp.staging-01234567-0123-4123-8123-0123456789ab'
        stage.mkdir(mode=0o700)
        (stage / 'original').write_bytes(b'abandoned original')
        os.chown(stage, 42001, 42001)
        os.chown(stage / 'original', 42001, 42001)
        legacy = self.base / 'erp.configure-lock'
        legacy.mkdir(mode=0o700)
        os.chown(legacy, 42001, 42001)
        self.recover()
        self.assertEqual(stage.stat().st_uid, 42001)
        self.assertEqual((stage / 'original').stat().st_uid, 42001)
        self.assertEqual((stage / 'original').read_bytes(), b'abandoned original')
        self.assertEqual(legacy.stat().st_uid, 42001)

    def test_link_hardlink_and_unexpected_base_entry_refuse(self):
        link = self.data / 'redirect'
        link.symlink_to(self.outside)
        with self.assertRaises(Exception):
            self.recover()
        link.unlink()
        os.link(self.outside, link)
        with self.assertRaises(Exception):
            self.recover()
        link.unlink()
        (self.base / 'unknown').mkdir()
        with self.assertRaises(Exception):
            self.recover()
        self.assertEqual(self.base.stat().st_uid, 42001)


if __name__ == '__main__':
    unittest.main()
