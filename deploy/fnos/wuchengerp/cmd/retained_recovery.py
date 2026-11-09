#!/usr/bin/python3
"""Root-owned install/upgrade hook; bounded retained-directory ownership recovery.

Uses system Python/POSIX dirfd operations, not the package-writable runtime.
All trees are checked before the first chown. Unknown data is never deleted.
"""
import contextlib
import ctypes
import fcntl
import json
import os
import re
import sqlite3
import stat
import sys

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
RECORDS = {'web-runtime.json', 'native-supervisor.json', '.integration-runtime.json',
           '.integration-start.lock', '.web-collector.json', 'command-lease.json'}
LOCKS = {'native-lifecycle.sqlite', 'native-ownership.sqlite'}
_libc = ctypes.CDLL(None, use_errno=True)
_fchownat = _libc.fchownat
_fchownat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_int]
_fchownat.restype = ctypes.c_int


def physical_directory(value):
    if not os.path.isabs(value) or os.path.normpath(value) != value:
        raise ValueError('Recovery requires an exact physical volume path')
    fd = os.open('/', DIRECTORY)
    try:
        for segment in value.split('/')[1:]:
            if segment:
                nxt = os.open(segment, DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def stopped_record(content):
    record = json.loads(content)
    if not isinstance(record, dict):
        raise ValueError('Uncertain retained runtime record')
    pids = []

    def walk(value):
        if isinstance(value, dict):
            if 'ownerPid' in value and value.get('childPid') is None:
                raise ValueError('Unpublished child PID is not proof of a stopped launch')
            for key, item in value.items():
                if key in ('pid', 'childPid', 'ownerPid'):
                    if type(item) is not int or item < 1:
                        raise ValueError('Invalid retained runtime PID')
                    pids.append(item)
                elif isinstance(item, (dict, list)):
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(record)
    if not pids:
        raise ValueError('Uncertain retained runtime record without PID')
    for pid in pids:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        raise ValueError('Retained service may still be running; stop it before recovery')


def quiescent_owners(owners):
    """Read-only census: root is trusted; no non-root owner may retain a writer.

    Scan thread credentials too (real/effective/saved/fs UID), since a thread
    with a saved owner UID can regain write/link authority without root.
    """
    for process in os.listdir('/proc'):
        if not process.isdecimal():
            continue
        try:
            tasks = os.listdir('/proc/' + process + '/task')
        except (FileNotFoundError, ProcessLookupError):
            continue
        for task in tasks:
            try:
                with open('/proc/' + process + '/task/' + task + '/status', 'rb') as status:
                    rows = [line.split()[1:] for line in status if line.startswith(b'Uid:')]
            except (FileNotFoundError, ProcessLookupError):
                continue
            if len(rows) != 1 or len(rows[0]) != 4:
                raise ValueError('Cannot establish owner UID process quiescence')
            matched = owners.intersection(int(value) for value in rows[0])
            if matched:
                raise ValueError('Retained owner/package UID ' + ','.join(str(value) for value in sorted(matched)) + ' still has task ' + process + '/' + task + '; stopped-only recovery refused')


def chown_inode(fd, uid, gid):
    # Python fchown rejects O_PATH descriptors. Linux fchownat AT_EMPTY_PATH
    # handles pinned regular files, directories and sockets without a pathname.
    if _fchownat(fd, b'', uid, gid, 0x1000 | 0x100) != 0:  # AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def recover(volume, uid, gid):
    if os.geteuid() != 0 or uid < 1 or gid < 0:
        raise ValueError('Recovery requires root and a non-root package UID')
    with contextlib.ExitStack() as stack:
        volfd = physical_directory(volume)
        stack.callback(os.close, volfd)
        try:
            os.mkdir('@wuchengerp-data', mode=0o700, dir_fd=volfd)
        except FileExistsError:
            pass
        basefd = os.open('@wuchengerp-data', DIRECTORY, dir_fd=volfd)
        stack.callback(os.close, basefd)
        device = os.fstat(volfd).st_dev
        if os.fstat(basefd).st_dev != device:
            raise ValueError('Retained BASE cannot cross a filesystem')
        # flock locks the physical BASE inode without placing a root file in a
        # package-writable directory, and automatically releases after a crash.
        fcntl.flock(basefd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        allowed = {'erp', 'backups', 'erp.configure-state'}
        original_top = set(os.listdir(basefd))
        # Crashed initializers own only their UUID stage. Keep abandoned copies
        # untouched; a subsequent initializer uses a new UUID, never deletes one.
        abandoned = {name for name in original_top if re.fullmatch(r'erp\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', name)}
        if 'erp.configure-lock' in original_top:
            abandoned.add('erp.configure-lock')  # Superseded mkdir lock: never reused or deleted.
        for name in abandoned:
            info = os.stat(name, dir_fd=basefd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or info.st_dev != device:
                raise ValueError('Abandoned stage must be a physical directory on this volume')
        if original_top - allowed - abandoned:
            raise ValueError('Unknown retained BASE entries; manual inspection required')
        entries = []
        directories = {}

        def inspect(parent, name, relative):
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if before.st_dev != device or stat.S_ISLNK(before.st_mode):
                raise ValueError('Retained path links/mounts are forbidden')
            if not (stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode) or stat.S_ISSOCK(before.st_mode)):
                raise ValueError('Unexpected retained special file')
            entries.append((relative, before))
            if stat.S_ISDIR(before.st_mode):
                fd = os.open(name, DIRECTORY, dir_fd=parent)
                try:
                    if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != (before.st_dev, before.st_ino):
                        raise ValueError('Retained directory changed during inspection')
                    children = sorted(os.listdir(fd))
                    directories[relative] = (before, children)
                    for child in children:
                        inspect(fd, child, relative + '/' + child)
                finally:
                    os.close(fd)
            elif stat.S_ISREG(before.st_mode) and name in RECORDS:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    if before.st_size > 1024 * 1024:
                        raise ValueError('Oversized retained runtime record')
                    stopped_record(os.read(fd, 1024 * 1024 + 1))
                finally:
                    os.close(fd)
            elif stat.S_ISREG(before.st_mode) and name in LOCKS:
                # Keep transactions open through ownership repair. No SQL data
                # is written, no lifecycle code or payload Node is run as root.
                retained_parent = os.dup(parent)
                stack.callback(os.close, retained_parent)
                db = sqlite3.connect('file:/proc/self/fd/' + str(retained_parent) + '/' + name + '?mode=rw', uri=True, timeout=0)
                stack.callback(db.close)
                # BEGIN EXCLUSIVE on a zero-byte coordination DB otherwise
                # creates a rollback journal and changes this copied inventory.
                # This connection never writes SQL data or commits. Keep its
                # journal in memory while retaining SQLite's exclusive lock.
                if before.st_size == 0:
                    if db.execute('PRAGMA journal_mode=MEMORY').fetchone() != ('memory',):
                        raise ValueError('Cannot hold empty coordination lock without a disk journal')
                db.execute('BEGIN EXCLUSIVE')

        for name in sorted(original_top - abandoned):
            if not stat.S_ISDIR(os.stat(name, dir_fd=basefd, follow_symlinks=False).st_mode):
                raise ValueError('Retained top-level entries must be directories')
            inspect(basefd, name, name)
        links = {}
        for _, info in entries:
            if stat.S_ISREG(info.st_mode):
                key = (info.st_dev, info.st_ino)
                links[key] = links.get(key, 0) + 1
        for _, info in entries:
            if stat.S_ISREG(info.st_mode) and links[(info.st_dev, info.st_ino)] != info.st_nlink:
                raise ValueError('Retained file has hard links outside validated trees')
        # An FD prevents pathname substitution, but an active owning process
        # could still add an external hardlink to the same inode. Require the
        # package and all non-root owners to have no tasks before any chown.
        # With a private BASE, non-writable public modes and protected_hardlinks,
        # other unprivileged UIDs cannot acquire that link authority either.
        owners = {uid, os.fstat(basefd).st_uid, *(info.st_uid for _, info in entries)} - {0}
        if os.fstat(basefd).st_mode & 0o077:
            raise ValueError('Retained BASE must already be private before ownership recovery')
        if any(info.st_mode & 0o022 for _, info in entries):
            raise ValueError('Retained paths writable by group/other cannot be recovered safely')
        with open('/proc/sys/fs/protected_hardlinks', encoding='ascii') as setting:
            if setting.read().strip() != '1':
                raise ValueError('Kernel protected_hardlinks must be enabled before recovery')
        quiescent_owners(owners)
        @contextlib.contextmanager
        def parent_for(relative):
            fd = os.dup(basefd)
            parts = relative.split('/')
            try:
                for index, part in enumerate(parts[:-1]):
                    nxt = os.open(part, DIRECTORY, dir_fd=fd)
                    os.close(fd)
                    fd = nxt
                    before = directories['/'.join(parts[:index + 1])][0]
                    current = os.fstat(fd)
                    if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                        raise ValueError('Retained ancestor changed during recovery')
                yield fd, parts[-1]
            finally:
                os.close(fd)

        def unchanged(current, before):
            if (current.st_dev, current.st_ino, current.st_mode, current.st_nlink, current.st_size, current.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_mode, before.st_nlink, before.st_size, before.st_mtime_ns):
                raise ValueError('Retained path changed during recovery')

        # Recheck the complete inventory before any ownership change. Reopen
        # ancestors using no-follow dirfds rather than holding one fd per event.
        if set(os.listdir(basefd)) != original_top:
            raise ValueError('Retained BASE changed during inspection')
        for relative, before in entries:
            with parent_for(relative) as (parent, name):
                unchanged(os.stat(name, dir_fd=parent, follow_symlinks=False), before)
                if relative in directories:
                    fd = os.open(name, DIRECTORY, dir_fd=parent)
                    try:
                        if sorted(os.listdir(fd)) != directories[relative][1]:
                            raise ValueError('Retained directory inventory changed')
                    finally:
                        os.close(fd)
        # A second complete census directly precedes repair. With no task
        # holding any owner UID, no unprivileged fork/UID-revert can introduce
        # an owner writer. Root/CAP_SETUID lifecycle actors are trusted and must
        # serialize installation; repeatedly scanning per file would not make
        # a privileged concurrent launch atomic, and would cost O(files*tasks).
        quiescent_owners(owners)
        for relative, before in reversed(entries):
            with parent_for(relative) as (parent, name):
                fd = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                try:
                    unchanged(os.fstat(fd), before)
                    chown_inode(fd, uid, gid)
                    unchanged(os.fstat(fd), before)
                    unchanged(os.stat(name, dir_fd=parent, follow_symlinks=False), before)
                finally:
                    os.close(fd)
        quiescent_owners(owners)
        os.fchown(basefd, uid, gid)
        os.fchmod(basefd, 0o700)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('Expected physical volume, package UID and GID')
        recover(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
    except Exception as error:
        print('ERP retained-data recovery refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
