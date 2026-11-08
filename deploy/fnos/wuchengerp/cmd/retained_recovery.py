#!/usr/bin/python3
"""Root-owned install/upgrade hook; bounded retained-directory ownership recovery.

Uses system Python/POSIX dirfd operations, not the package-writable runtime.
All trees are checked before the first chown. Unknown data is never deleted.
"""
import contextlib
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
            for key, item in value.items():
                if key in ('pid', 'childPid', 'ownerPid') and item is not None:
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

        def unchanged(parent, name, before):
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino, current.st_mode, current.st_nlink, current.st_size, current.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_mode, before.st_nlink, before.st_size, before.st_mtime_ns):
                raise ValueError('Retained path changed during recovery')

        # Recheck the complete inventory before any ownership change. Reopen
        # ancestors using no-follow dirfds rather than holding one fd per event.
        if set(os.listdir(basefd)) != original_top:
            raise ValueError('Retained BASE changed during inspection')
        for relative, before in entries:
            with parent_for(relative) as (parent, name):
                unchanged(parent, name, before)
                if relative in directories:
                    fd = os.open(name, DIRECTORY, dir_fd=parent)
                    try:
                        if sorted(os.listdir(fd)) != directories[relative][1]:
                            raise ValueError('Retained directory inventory changed')
                    finally:
                        os.close(fd)
        for relative, before in reversed(entries):
            with parent_for(relative) as (parent, name):
                unchanged(parent, name, before)
                os.chown(name, uid, gid, dir_fd=parent, follow_symlinks=False)
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
