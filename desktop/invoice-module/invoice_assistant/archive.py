"""Content-addressed local attachments; archive does not assert invoice authenticity."""
import hashlib
from pathlib import Path
from .store import uid, now


def attach(store,invoice_id,source):
    rows=store.rows("SELECT invoice_no,state FROM invoices WHERE id=?",(invoice_id,))
    if not rows or rows[0]["state"]!="issued" or not rows[0]["invoice_no"]:
        raise ValueError("请先核对并登记真实发票号码，再为该单据归档附件")
    source=Path(source)
    ext=source.suffix.lower()
    if ext not in (".pdf",".ofd",".xml",".png",".jpg",".jpeg") or source.stat().st_size>50*1024*1024:
        raise ValueError("仅接受不超过50MB的 PDF/OFD/XML/PNG/JPEG 附件")
    data=source.read_bytes()
    if not data:raise ValueError("不能归档空文件")
    sha=hashlib.sha256(data).hexdigest()
    dest=store.root/"归档"/"发票附件"/sha[:2]/(sha+ext)
    dest.parent.mkdir(parents=True,exist_ok=True)
    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest()!=sha:raise ValueError("既有归档内容被修改，停止覆盖")
    if not dest.exists():
        with dest.open("xb") as f:f.write(data)
    store.execute("INSERT OR IGNORE INTO archive_files VALUES(?,?,?,?,?,?,?,?)",
        (uid(),invoice_id,sha,str(dest),source.name,"user_attachment_unverified",0,now()))
    store.audit("archive_attachment",invoice_id,None,{"sha256":sha,"kind":"附件，未自动验真"})
    return str(dest)
