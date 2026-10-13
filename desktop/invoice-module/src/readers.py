# -*- coding: utf-8 -*-
"""
订单读取器：把放进「订单投放」文件夹的导出文件读进来，归一成统一字段。

支持：聚水潭ERP / 拼多多 / 淘宝天猫 / 京东 / 1688 / 抖音小店 / 钉钉AI表格 / 任意自定义表
格式：.xlsx .xls .csv
"""
import os
import re
import glob
from datetime import datetime

import openpyxl

from .fieldmap import (CANONICAL_FIELDS, COMMON_ALIASES,
                       SOURCE_SIGNATURES, SOURCE_ALIASES)

EXCEL_EXT = (".xlsx", ".xlsm", ".xls")
CSV_EXT = (".csv", ".tsv")


# ---------------------------------------------------------------
# 工具
# ---------------------------------------------------------------
def _clean(v):
    """把单元格值整理成干净字符串"""
    if v is None:
        return ""
    if isinstance(v, (datetime,)):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    s = str(v).strip()
    if s.endswith(".0") and re.match(r"^-?\d+\.0$", s):
        s = s[:-2]
    return s


def to_num(v, default=0.0):
    """'¥36.90' / '36.90元' / '1,234.5' / '' -> float"""
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return default
    neg = s.startswith("(") and s.endswith(")")
    s = re.sub(r"[^\d.\-]", "", s)
    if s in ("", "-", ".", "-."):
        return default
    try:
        n = float(s)
    except ValueError:
        return default
    return -n if neg else n


def to_str_time(v):
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    return _clean(v)


# ---------------------------------------------------------------
# 读原始表格
# ---------------------------------------------------------------
def _read_csv(path):
    import csv
    encodings = ["utf-8-sig", "gbk", "gb18030", "utf-8"]
    for enc in encodings:
        try:
            with open(path, "r", encoding=enc, newline="") as f:
                sample = f.read(4096)
                f.seek(0)
                delim = "\t" if path.endswith(".tsv") else ","
                rows = list(csv.reader(f, delimiter=delim))
            return [[_clean(c) for c in r] for r in rows]
        except UnicodeDecodeError:
            continue
    raise RuntimeError(f"CSV 编码无法识别：{path}")


def _read_excel(path):
    if os.path.splitext(path)[1].lower() == ".xls":
        import xlrd
        wb = xlrd.open_workbook(path, on_demand=True)
        try:
            ws = wb.sheet_by_index(0)
            rows = []
            for i in range(ws.nrows):
                row = []
                for cell in ws.row(i):
                    value = cell.value
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        value = xlrd.xldate_as_datetime(value, wb.datemode)
                    row.append(_clean(value))
                rows.append(row)
            return rows
        finally:
            wb.release_resources()
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb.worksheets[0]
    rows = []
    for r in ws.iter_rows(values_only=True):
        rows.append([_clean(c) for c in r])
        if len(rows) > 200000:
            break
    wb.close()
    return rows


def read_raw(path):
    """返回二维列表（全部为字符串）"""
    ext = os.path.splitext(path)[1].lower()
    if ext in CSV_EXT:
        return _read_csv(path)
    if ext in EXCEL_EXT:
        return _read_excel(path)
    raise RuntimeError(f"不支持的文件格式：{path}")


# ---------------------------------------------------------------
# 定位表头行
# ---------------------------------------------------------------
def _header_score(row):
    """这一行像不像表头：命中已知字段别名的数量"""
    joined = "".join(row)
    score = 0
    for aliases in COMMON_ALIASES.values():
        for a in aliases:
            if a in joined:
                score += 1
                break
    return score


def find_header_row(rows, max_scan=15):
    """扫描前若干行，挑最像表头的一行"""
    best_idx, best_score = 0, -1
    for i, row in enumerate(rows[:max_scan]):
        nonempty = [c for c in row if c]
        if len(nonempty) < 2:
            continue
        s = _header_score(row) + len(nonempty) * 0.01
        if s > best_score:
            best_idx, best_score = i, s
    return best_idx


# ---------------------------------------------------------------
# 来源识别
# ---------------------------------------------------------------
# 文件名特征（权重高于表头关键词 —— 导出时文件名通常就带平台名）
FILENAME_HINTS = {
    "聚水潭ERP": ["聚水潭", "jushuitan", "jst"],
    "拼多多":   ["拼多多", "pdd", "多多"],
    "淘宝天猫": ["淘宝", "天猫", "taobao", "tmall"],
    "京东":     ["京东", "jingdong"],
    "1688":     ["1688", "阿里巴巴"],
    "抖音小店": ["抖音", "抖店", "douyin"],
}


def detect_source(headers, filename=""):
    joined = "".join(str(h) for h in headers)
    fname = str(filename or "")
    scores = {}
    for src, sigs in SOURCE_SIGNATURES.items():
        hit = sum(1 for s in sigs if s in joined)
        if hit:
            scores[src] = hit
    for src, kws in FILENAME_HINTS.items():
        if any(k in fname for k in kws):
            scores[src] = scores.get(src, 0) + 5
    if not scores:
        return "通用表格"
    return max(scores.items(), key=lambda kv: kv[1])[0]


# ---------------------------------------------------------------
# 字段映射
# ---------------------------------------------------------------
def build_column_map(headers, source):
    """表头 -> {统一字段名: 列下标}"""
    cmap = {}
    src_alias = SOURCE_ALIASES.get(source, {})

    for field in CANONICAL_FIELDS:
        # 1) 完全相等优先
        for i, h in enumerate(headers):
            if h and h == field:
                cmap[field] = i
                break
        if field in cmap:
            continue
        # 2) 该来源专属别名
        for a in src_alias.get(field, []):
            hit = _find_alias(headers, a, cmap)
            if hit is not None:
                cmap[field] = hit
                break
        if field in cmap:
            continue
        # 3) 通用别名
        for a in COMMON_ALIASES.get(field, []):
            hit = _find_alias(headers, a, cmap)
            if hit is not None:
                cmap[field] = hit
                break
    return cmap


def _find_alias(headers, alias, cmap):
    """在表头里找包含 alias 的列（精确包含优先，已占用则跳过）"""
    used = set(cmap.values())
    # 先找完全相等的
    for i, h in enumerate(headers):
        if h == alias and i not in used:
            return i
    # 再找包含的，选最短的表头（更精准）
    cands = [(len(h), i) for i, h in enumerate(headers) if h and alias in h and i not in used]
    if not cands:
        return None
    return min(cands)[1]


# ---------------------------------------------------------------
# 归一化
# ---------------------------------------------------------------
def normalize_rows(rows, cmap, source, filename):
    """把原始行转成统一字典"""
    out = []
    for r in rows:
        if not any(r):
            continue

        def g(field):
            i = cmap.get(field)
            if i is None or i >= len(r):
                return ""
            return _clean(r[i])

        rec = {
            "来源": source,
            "来源文件": filename,
            "平台订单号": g("platform_order_no"),
            "ERP订单号": g("erp_order_no"),
            "子订单号": g("sub_order_no"),
            "店铺": g("shop"),
            "买家账号": g("buyer_account"),
            "收货人": g("receiver"),
            "手机号": g("phone"),
            "支付时间": to_str_time(r[cmap["pay_time"]]) if "pay_time" in cmap and cmap["pay_time"] < len(r) else "",
            "商品编码": g("sku_code"),
            "款式编码": g("style_code"),
            "商品名称": g("sku_name"),
            "规格": g("spec"),
            "数量": to_num(r[cmap["qty"]]) if "qty" in cmap and cmap["qty"] < len(r) else 1.0,
            "单位": g("unit") or "件",
            "单价": to_num(r[cmap["price"]]) if "price" in cmap and cmap["price"] < len(r) else 0.0,
            "金额": to_num(r[cmap["amount"]]) if "amount" in cmap and cmap["amount"] < len(r) else 0.0,
            "运费": to_num(r[cmap["freight"]]) if "freight" in cmap and cmap["freight"] < len(r) else 0.0,
            "快递公司": g("express"),
            "快递单号": g("express_no"),
            "买家留言": g("buyer_note"),
            "卖家备注": g("seller_note"),
            "订单状态": g("status"),
            "发票抬头": g("title"),
            "纳税人识别号": g("tax_no"),
            "购买方地址": g("buyer_addr"),
            "购买方开户行": g("buyer_bank"),
            "购买方银行账号": g("buyer_bank_acct"),
            "交付邮箱": g("buyer_email"),
        }
        # 明确填写 0 的数量保留，由校验报告提示修正。
        # 金额兜底：没有金额列就用 单价×数量
        if not rec["金额"] and rec["单价"]:
            rec["金额"] = round(rec["单价"] * rec["数量"], 2)
        out.append(rec)
    return out


def parse_file(path):
    """读一个文件，返回 (归一化行列表, 来源, 表头)"""
    rows = read_raw(path)
    if not rows:
        return [], "通用表格", []
    hi = find_header_row(rows)
    headers = rows[hi]
    body = rows[hi + 1:]
    source = detect_source(headers, os.path.basename(path))
    cmap = build_column_map(headers, source)
    recs = normalize_rows(body, cmap, source, os.path.basename(path))
    return recs, source, headers


def scan_folder(folder):
    """扫描文件夹下所有订单文件"""
    files = []
    for ext in EXCEL_EXT + CSV_EXT:
        files += glob.glob(os.path.join(folder, "*" + ext))
        files += glob.glob(os.path.join(folder, "*" + ext.upper()))
    # 跳过 Excel 临时文件
    files = [f for f in sorted(set(files)) if not os.path.basename(f).startswith("~$")]
    return files
