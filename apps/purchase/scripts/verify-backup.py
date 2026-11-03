import json
import pathlib
import sqlite3
import zipfile

archive = sorted(pathlib.Path('data/backups').glob('*.zip'))[-1]
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    copy = pathlib.Path('.tmp/verified-backup.sqlite')
    copy.write_bytes(z.read('purchases.sqlite'))
    with sqlite3.connect(copy) as db:
        integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
        count = db.execute('SELECT COUNT(*) FROM orders').fetchone()[0]
        amount = db.execute("SELECT SUM(amount_cents-refund_cents) FROM orders WHERE status IN ('已完成','待发货','待收货')").fetchone()[0]
        for (file_path,) in db.execute('SELECT file_path FROM imports'):
            assert file_path in z.namelist()
        assert integrity == 'ok'
        print(json.dumps({'backup': str(archive.resolve()), 'integrity': integrity, 'orders': count, 'effective_cents': amount, 'attachments_present': True}, ensure_ascii=False))
