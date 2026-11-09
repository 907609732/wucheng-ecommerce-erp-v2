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

    def install_hook(self):
        # Exercise the actual root-owned shell/helper chain in the existing
        # isolated CI root suite, with a private inactive package UID.
        import pwd
        username = 'erp-init-' + str(os.getpid())
        subprocess.run(['useradd', '--system', '--no-create-home', '--user-group', username], check=True)
        self.addCleanup(subprocess.run, ['userdel', username], check=True)
        package = pwd.getpwnam(username)
        cmd = self.root / 'cmd'
        cmd.mkdir(mode=0o700)
        for name in ['install_init', 'native_env', 'retained_recovery.py']:
            shutil.copyfile(HELPER.parent / name, cmd / name)
            (cmd / name).chmod(0o600)
        target = self.root / 'undeployed-target'
        env = {**os.environ, 'TRIM_APPDEST': str(target), 'TRIM_APPDEST_VOL': str(self.volume), 'TRIM_USERNAME': username}
        env.pop('TRIM_TEMP_LOGFILE', None)
        def run():
            return subprocess.run(['/bin/sh', str(cmd / 'install_init')], env=env, capture_output=True, text=True, timeout=30)
        return run, target, package, env

    def test_install_init_prepares_private_base_before_payload_deployment(self):
        run, target, package, env = self.install_hook()
        shutil.rmtree(self.base)
        for dangling in [False, True]:
            if dangling:
                target.symlink_to(self.root / 'absent-payload', target_is_directory=True)
            result = run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.base.stat().st_uid, package.pw_uid)
            self.assertEqual(self.base.stat().st_gid, package.pw_gid)
            self.assertEqual(self.base.stat().st_mode & 0o777, 0o700)
            self.assertFalse(self.data.exists())
            self.assertFalse(target.exists())
            self.assertEqual(target.is_symlink(), dangling)
        for volume in ['', str(self.root / 'absent-volume'), str(self.outside)]:
            env['TRIM_APPDEST_VOL'] = volume
            result = run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('存储卷', result.stderr)
        self.assertFalse(self.data.exists())
        self.assertEqual(self.outside.read_bytes(), b'never chown')
        self.assertEqual(self.outside.stat().st_uid, 0)

    def test_install_init_refuses_unsafe_retained_then_recovers_without_payload(self):
        run, target, package, env = self.install_hook()
        log = self.root / 'install-error.log'
        env['TRIM_TEMP_LOGFILE'] = str(log)
        target.symlink_to(self.root / 'absent-payload', target_is_directory=True)
        before = {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        unsafe = self.data / 'originals' / 'linked'
        unsafe.symlink_to(self.outside)
        result = run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('保留账本恢复被阻止', result.stderr)
        self.assertIn('Retained path links/mounts are forbidden', log.read_text())
        self.assertTrue(all(p.lstat().st_uid == 42001 for p in [self.base, *self.base.rglob('*')] if p != unsafe))
        self.assertEqual(self.outside.stat().st_uid, 0)
        unsafe.unlink()
        result = run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(p.stat().st_uid == package.pw_uid for p in [self.base, *self.base.rglob('*')]))
        self.assertEqual({str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*') if p.is_file()}, before)
        self.assertFalse((self.data / 'config' / 'web.json').exists())
        self.assertFalse(target.exists())
        self.assertTrue(target.is_symlink())
        self.assertEqual(self.outside.read_bytes(), b'never chown')

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

    def test_idle_coordination_locks_preserve_bytes_inventory_and_exclusion(self):
        backup_state = self.base / 'backups' / 'retained' / 'preflight.configure-state'
        backup_state.mkdir(mode=0o700)
        os.chown(backup_state, 42001, 42001)
        locks = [self.data / 'state' / 'native-ownership.sqlite',
                 backup_state / 'native-lifecycle.sqlite',
                 self.data / 'state' / 'native-lifecycle.sqlite']
        for lock in locks:
            lock.write_bytes(b'')
            lock.chmod(0o600)
            os.chown(lock, 42001, 42001)
        initialized = sqlite3.connect(locks[-1])
        initialized.execute('CREATE TABLE retained(value TEXT)')
        initialized.execute('INSERT INTO retained VALUES(?)', ('coordination fixture',))
        initialized.commit()
        initialized.close()
        def inventory(read_bytes=True):
            result = {}
            for p in [self.base, *self.base.rglob('*')]:
                info = p.lstat()
                result[str(p.relative_to(self.base))] = (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, p.read_bytes() if read_bytes and p.is_file() else None)
            return result
        before = inventory()
        metadata = {name: values[:-1] for name, values in before.items()}
        chown_count = 0
        checked = []
        original = self.module.chown_inode
        def check_exclusion(fd, uid, gid):
            nonlocal chown_count
            chown_count += 1
            if chown_count in (1, len(before) - 1):
                checked.append(chown_count)
                # Closing any ordinary FD for a locked inode drops this process's
                # POSIX locks. Read bytes only before/after recovery, never here.
                self.assertEqual({name: values[:-1] for name, values in inventory(read_bytes=False).items()}, metadata, 'holding locks must not create journals or mutate copied data')
                script = """import sqlite3,sys
db=sqlite3.connect(sys.argv[1],timeout=0)
try:
    db.execute('BEGIN EXCLUSIVE')
except sqlite3.OperationalError as error:
    assert error.sqlite_errorcode == sqlite3.SQLITE_BUSY, repr(error)
    print('SQLITE_BUSY')
else:
    raise AssertionError('recovery did not hold the coordination lock')
finally:
    db.close()
"""
                for lock in locks:
                    result = subprocess.run([sys.executable, '-I', '-B', '-c', script, str(lock)], capture_output=True, text=True, timeout=10)
                    context = str(lock.relative_to(self.base)) + ' before chown #' + str(chown_count)
                    self.assertEqual(result.returncode, 0, context + ': ' + result.stderr)
                    self.assertEqual(result.stdout.strip(), 'SQLITE_BUSY', context)
            original(fd, uid, gid)
        with mock.patch.object(self.module, 'chown_inode', side_effect=check_exclusion):
            self.recover()
        self.assertEqual(checked, [1, len(before) - 1])
        self.assertEqual(inventory(), before)
        self.assertTrue(all(p.stat().st_uid == 42002 for p in [self.base, *self.base.rglob('*')]))
        self.assertEqual([p.stat().st_size for p in locks[:2]], [0, 0])

    def test_busy_sqlite_ownership_refuses_before_chown(self):
        lock = self.data / 'state' / 'native-ownership.sqlite'
        lock.write_bytes(b'')
        os.chown(lock, 42001, 42001)
        script = "import sqlite3,sys; db=sqlite3.connect(sys.argv[1],timeout=0); db.execute('BEGIN EXCLUSIVE'); print('ready',flush=True); sys.stdin.read(); db.close()"
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', script, str(lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with self.assertRaises(sqlite3.OperationalError) as refused:
                self.recover()
            self.assertEqual(refused.exception.sqlite_errorcode, sqlite3.SQLITE_BUSY)
            self.assertEqual(self.base.stat().st_uid, 42001)
            self.assertEqual(lock.stat().st_uid, 42001)
            self.assertEqual(lock.read_bytes(), b'')
        finally:
            child.communicate('', timeout=5)

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
