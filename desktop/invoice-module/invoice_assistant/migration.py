import json
from pathlib import Path
import openpyxl
import yaml
from .store import dump, fingerprint, now, uid
from .templates import register


def read_table(path):
    if not Path(path).exists():
        return []
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        data = list(wb.active.values)
        heads = [str(v or "").strip() for v in data[0]] if data else []
        return [{k:str(row[i] if i<len(row) and row[i] is not None else "").strip() for i,k in enumerate(heads)}
                for row in data[1:] if any(row)]
    finally:
        wb.close()


def migrate(store, legacy_root=None):
    source = Path(legacy_root) if legacy_root else store.root
    key = "legacy-v1-to-v2"
    done = store.rows("SELECT report FROM migrations WHERE key=?", (key,))
    if done:
        return json.loads(done[0]["report"])
    report = {"已开票":0,"抬头映射":0,"商品候选":0,"忽略示例":0,"注意":[]}
    cfg_path = source / "config.yaml"
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    mapping_rows = []
    for row in read_table(source / "数据" / "发票抬头库.xlsx"):
        if "示例" in row.get("备注", "") or "示例" in row.get("发票抬头", ""):
            report["忽略示例"] += 1
            continue
        if row.get("匹配键值"):
            mapping_rows.append(("legacy_customer", row["匹配键类型"]+":"+row["匹配键值"], row))
            report["抬头映射"] += 1
    for row in read_table(source / "数据" / "税收编码映射.xlsx"):
        if row.get("关键词"):
            mapping_rows.append(("keyword_candidate", row["关键词"], row))
            report["商品候选"] += 1
    issued = []
    for row in read_table(source / "数据" / "已开票记录.xlsx"):
        if row.get("发票号码") and row.get("平台订单号"):
            issued.append((row["平台订单号"], row["发票号码"], "v1已开票记录"))
            report["已开票"] += 1
        elif row.get("平台订单号"):
            report["注意"].append("有旧记录缺发票号码，未作为已开票导入")
    with store.connect() as conn:
        initial = {"seller":cfg.get("seller",{}), "default_rate":str(cfg.get("tax",{}).get("default_rate","0.01")),
                   "seller_confirmed":False, "targets":["xinfutong","zhejiang"],
                   "max_lines":int(cfg.get("rules",{}).get("max_lines_per_invoice",100))}
        for k,v in initial.items():
            conn.execute("INSERT OR IGNORE INTO settings VALUES(?,?)", (k,dump(v)))
        for kind,mkey,value in mapping_rows:
            conn.execute("INSERT OR IGNORE INTO mappings VALUES(?,?,?,?,?)", (uid(),kind,mkey,dump(value),now()))
        conn.executemany("INSERT OR IGNORE INTO legacy_issued VALUES(?,?,?)",issued)
        conn.execute("INSERT INTO migrations VALUES(?,?,?)", (key,now(),dump(report)))
    template = source / "模板" / "新福通通用开票申请单模板.xlsx"
    if template.exists() and not store.rows("SELECT target FROM templates WHERE target='xinfutong'"):
        try:
            register(store,"xinfutong",template)
        except ValueError as e:
            report["注意"].append(str(e))
    path = store.root / "数据" / "迁移报告_v2.json"
    store.execute("UPDATE migrations SET report=? WHERE key=?",(dump(report),key))
    path.write_text(dump(report),encoding="utf-8")
    return report
