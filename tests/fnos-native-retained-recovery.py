"""Linux/root-only integration: synthetic old/new owners, no NAS or real data."""
import importlib.util
import ast
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock
import subprocess
import socket
import sys
from types import SimpleNamespace

HELPER = Path(__file__).resolve().parents[1] / 'deploy/fnos/wuchengerp/cmd/retained_recovery.py'


class Records(unittest.TestCase):
    def test_unpublished_child_refuses_even_with_dead_owner(self):
        # Execute the actual pure parser on Windows too; only PID liveness is
        # supplied as a dead-process probe, not Linux ownership emulation.
        source = ast.parse(HELPER.read_text(encoding='utf-8'))
        parser = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'stopped_record')
        def dead(*_):
            raise ProcessLookupError()
        namespace = {'json': json, 'os': SimpleNamespace(kill=dead)}
        exec(compile(ast.Module(body=[parser], type_ignores=[]), str(HELPER), 'exec'), namespace)
        for record in [{'ownerPid': 99999999, 'childPid': None, 'executable': 'cm'}, {'ownerPid': 99999999, 'childPid': None, 'module': 'sales'}, {'ownerPid': 99999999, 'module': 'sales'}]:
            with self.subTest(record=record), self.assertRaises(ValueError):
                namespace['stopped_record'](json.dumps(record))


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
        self.base.chmod(0o700)
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

    def test_unpublished_launch_records_refuse_without_ownership_changes(self):
        before = {str(p): p.stat().st_uid for p in [self.base, *self.base.rglob('*')]}
        for name in ['command-lease.json', '.integration-start.lock']:
            record = self.data / 'state' / name
            record.write_text(json.dumps({'ownerPid': 99999999, 'childPid': None}))
            os.chown(record, 42001, 42001)
            with self.assertRaises(Exception):
                self.recover()
            self.assertEqual({str(p): p.stat().st_uid for p in [self.base, *self.base.rglob('*')] if str(p) in before}, before)
            record.unlink()

    def test_substitution_at_ownership_mutation_never_chowns_outside_inode(self):
        victim = self.data / 'originals' / 'bill'
        inode = victim.stat().st_ino
        substituted = False
        def replace():
            nonlocal substituted
            substituted = True
            victim.unlink()
            os.link(self.outside, victim)
        if hasattr(self.module, 'chown_inode'):
            original = self.module.chown_inode
            def mutate(fd, uid, gid):
                if os.fstat(fd).st_ino == inode:
                    replace()
                return original(fd, uid, gid)
            patcher = mock.patch.object(self.module, 'chown_inode', mutate)
        else:
            original = os.chown
            def mutate(name, uid, gid, **kwargs):
                if str(name) == 'bill':
                    replace()
                return original(name, uid, gid, **kwargs)
            patcher = mock.patch.object(os, 'chown', mutate)
        with patcher:
            try:
                self.recover()
            except (ValueError, OSError):
                pass
        self.assertTrue(substituted, 'test must replace the entry at the actual mutation boundary')
        self.assertEqual(self.outside.stat().st_uid, 0)
        self.assertEqual(self.outside.read_bytes(), b'never chown')

    def test_live_old_uid_writer_refuses_before_ownership_change(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], user=42001, group=42001, cwd='/')
        try:
            with self.assertRaisesRegex(ValueError, 'UID|owner|process'):
                self.recover()
            self.assertEqual(self.base.stat().st_uid, 42001)
            self.assertEqual((self.data / 'originals' / 'bill').stat().st_uid, 42001)
        finally:
            child.terminate()
            child.wait(timeout=5)

    def test_stale_socket_and_directories_use_descriptor_ownership(self):
        endpoint = self.data / 'state' / 'stale.sock'
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(endpoint))
        endpoint.chmod(0o600)
        os.chown(endpoint, 42001, 42001)
        self.recover()
        self.assertEqual(endpoint.stat().st_uid, 42002)
        self.assertEqual(endpoint.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.data / 'state').stat().st_uid, 42002)

    def test_full_uid_census_count_is_bounded_as_file_count_grows(self):
        for index in range(64):
            entry = self.data / 'originals' / ('extra-' + str(index))
            entry.write_bytes(b'retained bytes')
            os.chown(entry, 42001, 42001)
        with mock.patch.object(self.module, 'quiescent_owners', wraps=self.module.quiescent_owners) as census:
            self.recover()
        self.assertLessEqual(census.call_count, 3, 'full /proc scans must not grow with file count')

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
