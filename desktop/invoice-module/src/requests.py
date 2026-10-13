# -*- coding: utf-8 -*-
"""
开票申请单解析

无论数据来自聚水潭「买家开票申请」还是电商平台后台的「导出申请数据」，
都归一成同一套字段，这样后面的处理流水线两种模式完全共用。

关键点：申请单是「权威数据源」—— 买家申请开票时自己填的抬头和税号，
比我们从订单里猜要准得多。
"""
import os

from .readers import _clean, to_num, to_str_time, _find_alias

REQUEST_FIELDS = [
    "req_source",   # 来源：聚水潭 / 拼多多 / 京东 / 淘宝
    "platform",     # 平台
    "shop",         # 店铺名称
    "sale_no",      # 销售单号（ERP 内部单号）
    "order_no",     # 线上订单号 / 平台订单号
    "apply_time",   # 申请时间
    "order_time",   # 订单时间 / 支付时间
    "title_type",   # 抬头类型：单位 / 个人
    "invoice_type",  # 发票类型：全电发票(普通发票) / 专用发票
    "title",        # 发票抬头
    "tax_no",       # 纳税人识别号
    "amount",       # 申请开票金额
    "email",        # 交付邮箱
    "buyer_account",  # 买家账号
    "status",       # 申请状态
    "remark",       # 备注
]

# 通用别名（越靠前越优先）
REQUEST_ALIASES = {
    # 注意：线上订单号要排在销售单号前面判断，否则会被 ERP 内部单号抢走
    "order_no":      ["线上订单号", "平台订单号", "订单编号", "订单号", "交易订单号", "子订单号"],
    "sale_no":       ["销售单号", "内部订单号", "系统订单号", "ERP订单号"],
    "apply_time":    ["申请时间", "申请日期", "开票预计时间", "要求开票时间", "提交时间"],
    "order_time":    ["订单时间", "订单支付日期", "支付时间", "付款时间", "下单时间", "成交时间"],
    "title_type":    ["抬头类型"],
    "invoice_type":  ["发票类型", "开票类型"],
    "title":         ["抬头名称", "发票抬头", "购买方名称", "单位名称", "客户名称", "抬头", "购方名称"],
    "tax_no":        ["纳税人识别号", "企业税号", "税号", "统一社会信用代码", "识别号"],
    "amount":        ["发票金额", "开票金额", "申请金额", "开票额", "订单金额", "实付金额", "价税合计"],
    "email":         ["邮箱", "电子邮箱", "交付邮箱", "收票邮箱", "EMAIL"],
    "buyer_account": ["买家账号", "买家昵称", "买家会员名", "买家", "客户账号"],
    "status":        ["当前状态", "开票状态", "审核状态", "申请状态", "处理状态", "状态"],
    "shop":          ["店铺名称", "店铺", "来源店铺"],
    "platform":      ["平台", "来源平台"],
    "remark":        ["备注", "其他信息", "备注信息"],
}

# 各来源专属别名（覆盖通用规则）
SOURCE_REQUEST_ALIASES = {
    "聚水潭ERP": {
        # 聚水潭「买家开票申请」列表的实际列名
        "order_no": ["线上订单号"],
        "sale_no":  ["销售单号"],
        "title":    ["抬头名称"],
        "amount":   ["发票金额"],
        "remark":   ["备注"],
        "platform": ["平台"],
        "shop":     ["店铺名称"],
    },
    "拼多多": {
        "amount": ["发票金额(元)", "发票金额", "开票金额"],
        "title":  ["发票抬头", "抬头"],
        "tax_no": ["企业税号", "纳税人识别号", "税号"],
    },
    "京东": {
        "title": ["发票抬头", "抬头"],
        "tax_no": ["企业税号", "纳税人识别号"],
    },
}

# 「这个文件是开票申请单还是订单明细」的判别关键词
TITLE_KEYS = ["发票抬头", "抬头名称", "纳税人识别号", "税号", "开票金额", "发票金额",
              "抬头类型", "发票类型", "开票状态", "申请时间", "申请日期"]
ITEM_KEYS = ["商品名称", "货品名称", "宝贝标题", "商品标题", "商品名", "产品名称"]
QTY_KEYS = ["数量", "购买数量", "商品数量", "宝贝总数量"]


def detect_file_role(headers):
    """
    判断文件角色：
      request —— 只有开票申请信息，没有商品明细（聚水潭开票申请、平台发票申请导出）
      detail  —— 只有订单商品明细
      both    —— 两者都有（既可作为申请来源，也可提供明细）
    """
    joined = "".join(str(h) for h in headers)
    has_title = any(k in joined for k in TITLE_KEYS)
    has_item = any(k in joined for k in ITEM_KEYS) and any(k in joined for k in QTY_KEYS)

    if has_title and has_item:
        return "both"
    if has_title:
        return "request"
    if has_item:
        return "detail"
    return "detail"


def build_request_map(headers, source):
    """申请单字段 -> 列下标"""
    cmap = {}
    src_alias = SOURCE_REQUEST_ALIASES.get(source, {})
    for field in REQUEST_FIELDS:
        for a in src_alias.get(field, []):
            hit = _find_alias(headers, a, cmap)
            if hit is not None:
                cmap[field] = hit
                break
        if field in cmap:
            continue
        for a in REQUEST_ALIASES.get(field, []):
            hit = _find_alias(headers, a, cmap)
            if hit is not None:
                cmap[field] = hit
                break
    return cmap


def normalize_request_rows(rows, cmap, source, filename):
    """原始行 -> 统一的开票申请单"""
    out = []
    for r in rows:
        if not any(r):
            continue

        def g(field):
            i = cmap.get(field)
            if i is None or i >= len(r):
                return ""
            return _clean(r[i])

        def num(field):
            i = cmap.get(field)
            if i is None or i >= len(r):
                return 0.0
            return to_num(r[i])

        rec = {
            "req_source": source,
            "req_file": filename,
            "platform": g("platform"),
            "shop": g("shop"),
            "sale_no": g("sale_no"),
            "order_no": g("order_no"),
            "apply_time": to_str_time(r[cmap["apply_time"]]) if "apply_time" in cmap and cmap["apply_time"] < len(r) else "",
            "order_time": to_str_time(r[cmap["order_time"]]) if "order_time" in cmap and cmap["order_time"] < len(r) else "",
            "title_type": g("title_type"),
            "invoice_type": g("invoice_type"),
            "title": g("title"),
            "tax_no": g("tax_no"),
            "amount": num("amount"),
            "_amount_present": bool(g("amount")),
            "email": g("email"),
            "buyer_account": g("buyer_account"),
            "status": g("status"),
            "remark": g("remark"),
        }
        if not (rec["order_no"] or rec["sale_no"]):
            continue
        # 抬头是「个人」时没有税号是正常的，不当作缺失
        out.append(rec)
    return out


def is_personal(title_type, tax_no):
    """个人抬头不需要税号"""
    t = str(title_type or "")
    if "个人" in t:
        return True
    tn = str(tax_no or "")
    return not tn


def parse_file_full(path):
    """
    读一个文件，同时给出「明细行」和「开票申请行」，并标明文件角色。
    返回 dict 或 None。
    """
    # 延迟导入，避免与 readers 形成循环依赖
    from .readers import (read_raw, find_header_row, detect_source,
                          build_column_map, normalize_rows)

    rows = read_raw(path)
    if not rows:
        return None
    hi = find_header_row(rows)
    headers = rows[hi]
    body = rows[hi + 1:]
    fname = os.path.basename(path)
    source = detect_source(headers, fname)
    role = detect_file_role(headers)

    detail_recs, request_recs = [], []
    if role in ("detail", "both"):
        cmap = build_column_map(headers, source)
        detail_recs = normalize_rows(body, cmap, source, fname)
    if role in ("request", "both"):
        rcmap = build_request_map(headers, source)
        request_recs = normalize_request_rows(body, rcmap, source, fname)

    return {
        "path": path,
        "file": fname,
        "source": source,
        "role": role,
        "headers": headers,
        "detail_rows": detail_recs,
        "request_rows": request_recs,
    }


def load_all(files, mode="auto"):
    """
    扫描结果 -> (订单明细行, {订单号: 申请单}, 文件概要)

    mode:
      erp       只收聚水潭来源
      platform  只收平台来源（非聚水潭）
      auto      全收
    """
    details, req_map, summary = [], {}, []

    for f in files:
        try:
            info = parse_file_full(f)
        except Exception as e:
            summary.append({"file": os.path.basename(f), "source": "读取失败",
                            "role": "-", "detail": 0, "request": 0, "error": str(e)})
            continue
        if not info:
            continue

        source = info["source"]
        # 模式过滤
        if mode == "erp" and source != "聚水潭ERP":
            continue
        if mode == "platform" and source == "聚水潭ERP":
            continue

        details += info["detail_rows"]

        # 申请单按订单号入索引；专门的「开票申请」文件优先级高于「两者都有」的订单文件
        for r in info["request_rows"]:
            for key in (r["order_no"], r["sale_no"]):
                key = str(key or "").strip()
                if not key:
                    continue
                old = req_map.get(key)
                if old and old.get("_role") == "request" and info["role"] == "request":
                    if any(old.get(k) != r.get(k) for k in ("title", "tax_no", "amount", "invoice_type")):
                        old["_conflict"] = True
                if old is None or (info["role"] == "request" and old.get("_role") != "request"):
                    r = dict(r)
                    r["_role"] = info["role"]
                    req_map[key] = r

        summary.append({
            "file": info["file"], "source": source, "role": info["role"],
            "detail": len(info["detail_rows"]), "request": len(info["request_rows"]),
        })

    return details, req_map, summary
