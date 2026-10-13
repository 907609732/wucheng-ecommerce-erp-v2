# -*- coding: utf-8 -*-
"""
台账处理：抬头匹配 / 税收编码匹配 / 价税分离 / 去重 / 分组开票
"""
import os
import re
from collections import OrderedDict

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

from .readers import to_num


# ---------------------------------------------------------------
# 对照库读写
# ---------------------------------------------------------------
CUSTOMER_COLS = ["匹配键类型", "匹配键值", "发票抬头", "纳税人识别号",
                 "地址电话", "开户行", "银行账号", "交付邮箱", "备注"]
TAXCODE_COLS = ["关键词", "开票商品名称", "税收分类编码", "税率", "单位", "规格型号", "备注"]
ISSUED_COLS = ["平台订单号", "ERP订单号", "发票号码", "开票日期", "价税合计", "抬头"]


def _ensure_lib(path, cols, sample_rows=None):
    """对照库不存在就建一个空模板"""
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(cols)
    head_fill = PatternFill("solid", fgColor="1F4E79")
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF", size=11)
        c.fill = head_fill
        c.alignment = Alignment(horizontal="center", vertical="center")
    for row in (sample_rows or []):
        ws.append(row)
    for i, col in enumerate(cols, 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = max(14, len(col) * 2 + 4)
    ws.freeze_panes = "A2"
    wb.save(path)


def ensure_libs(cfg):
    p = cfg["paths"]
    _ensure_lib(p["customer_lib"], CUSTOMER_COLS, [
        ["买家账号", "示例昵称", "示例科技有限公司", "91330000XXXXXXXXXX", "", "", "", "", "示例行，可删"],
    ])
    # 注意：「开票商品名称」留空 = 沿用订单里的原始商品名，别乱改，
    # 开票品名要跟实际货物一致。只有想统一叫法时才填这一列。
    # 税率列留空 = 用 config.yaml 里的 default_rate，避免这里覆盖全局税率
    _ensure_lib(p["taxcode_lib"], TAXCODE_COLS, [
        ["锁芯", "", "", "", "个", "", "「税收分类编码」必填，从开票系统商品编码库里查"],
        ["螺丝", "", "", "", "套", "", ""],
        ["钥匙", "", "", "", "个", "", ""],
        ["门锁", "", "", "", "台", "", ""],
    ])
    _ensure_lib(p["issued_ledger"], ISSUED_COLS)


def _read_lib(path, cols):
    if not os.path.exists(path):
        return []
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return []
    header = [str(c).strip() if c else "" for c in rows[0]]
    idx = {c: i for i, c in enumerate(header) if c}
    out = []
    for r in rows[1:]:
        if not any(r):
            continue
        rec = {}
        for c in cols:
            i = idx.get(c)
            rec[c] = r[i] if (i is not None and i < len(r) and r[i] is not None) else ""
        if isinstance(rec.get(cols[1]), (int, float)):
            rec[cols[1]] = str(rec[cols[1]])
        out.append(rec)
    return out


def load_customers(path):
    """-> {(类型, 键值): 抬头信息}"""
    lib = {}
    for r in _read_lib(path, CUSTOMER_COLS):
        ktype = str(r.get("匹配键类型", "")).strip()
        kval = str(r.get("匹配键值", "")).strip()
        if not ktype or not kval:
            continue
        if str(r.get("发票抬头", "")).strip() in ("示例科技有限公司",):
            continue
        lib[(ktype, kval)] = r
    return lib


def load_taxcodes(path):
    """-> [(关键词, 信息)]，按关键词长度倒序，长的优先匹配"""
    rows = []
    for r in _read_lib(path, TAXCODE_COLS):
        kw = str(r.get("关键词", "")).strip()
        if not kw:
            continue
        r["_kw"] = kw
        rows.append(r)
    rows.sort(key=lambda x: -len(x["_kw"]))
    return rows


def load_issued(path):
    """-> set(订单号)"""
    s = set()
    if not os.path.exists(path):
        return s
    for r in _read_lib(path, ISSUED_COLS):
        if not str(r.get("发票号码") or "").strip():
            continue
        for k in ("平台订单号", "ERP订单号"):
            v = str(r.get(k, "")).strip()
            if v:
                s.add(v)
    return s


# ---------------------------------------------------------------
# 匹配
# ---------------------------------------------------------------
def match_customer(rec, lib):
    """按 平台订单号 > 买家账号 > 手机号 > 收货人 依次匹配抬头"""
    for ktype, val in (("平台订单号", rec.get("平台订单号")),
                       ("买家账号", rec.get("买家账号")),
                       ("手机号", rec.get("手机号")),
                       ("收货人", rec.get("收货人"))):
        val = str(val or "").strip()
        if not val:
            continue
        hit = lib.get((ktype, val))
        if hit:
            return hit, ktype
    return None, ""


def match_taxcode(name, taxcodes):
    """商品名称里包含关键词即命中，取最长关键词"""
    name = str(name or "")
    for r in taxcodes:
        if r["_kw"] in name:
            return r
    return None


def split_tax(amount, rate, tax_included=True):
    """价税分离：返回 (不含税金额, 税额)，保证两者之和 == amount"""
    amount = round(float(amount or 0), 2)
    rate = float(rate or 0)
    if tax_included:
        net = round(amount / (1 + rate), 2) if rate else amount
        tax = round(amount - net, 2)
    else:
        net = amount
        tax = round(amount * rate, 2)
    return net, tax


# ---------------------------------------------------------------
# 主处理
# ---------------------------------------------------------------
def dedupe_cross_source(records):
    """
    同一笔订单同时出现在 ERP 导出和平台后台导出时，只保留信息最完整的那一组
    （整套明细一起保留，不会把一单多商品拆散）。
    打分：带了抬头+税号的行权重更高。
    """
    from collections import OrderedDict as OD
    groups = OD()
    no_order = []
    for rec in records:
        on = str(rec.get("平台订单号") or rec.get("ERP订单号") or "").strip()
        if not on:
            no_order.append(rec)
            continue
        groups.setdefault(on, OD()).setdefault(rec.get("来源文件", ""), []).append(rec)

    out = list(no_order)
    for on, fg in groups.items():
        if len(fg) == 1:
            out += list(fg.values())[0]
            continue
        best, best_score = None, -1
        for recs in fg.values():
            score = sum(10 for r in recs
                        if str(r.get("发票抬头", "")).strip()
                        and str(r.get("纳税人识别号", "")).strip()) + len(recs)
            if score > best_score:
                best_score, best = score, recs
        out += best
    return out


def validate_amounts(records, req_map):
    """
    按订单号汇总明细金额，与开票申请上买家申请的金额比对。
    这是防开错票的关键 —— 有优惠、运费、部分退款时两者会对不上。
    """
    agg = {}
    for rec in records:
        keys = {str(rec.get(k) or "").strip() for k in ("平台订单号", "ERP订单号")}
        for on in keys - {""}:
            agg[on] = agg.get(on, 0.0) + float(rec.get("金额") or 0)

    out = {}
    for on, req in req_map.items():
        if on not in agg:
            continue
        dsum = round(agg[on], 2)
        ramt = round(float(req.get("amount") or 0), 2)
        diff = round(dsum - ramt, 2)
        out[on] = {
            "detail_sum": dsum,
            "req_amount": ramt,
            "ok": abs(diff) < 0.02 or (ramt == 0 and not req.get("_amount_present")),
            "diff": diff,
        }
    return out


def find_orphan_requests(records, req_map):
    """
    有买家开了开票申请，但在订单明细里找不到对应订单 —— 这种情况必须提醒，
    否则这张票就被漏掉了。
    """
    detail_keys = set()
    for rec in records:
        for k in (rec.get("平台订单号"), rec.get("ERP订单号")):
            k = str(k or "").strip()
            if k:
                detail_keys.add(k)

    seen, orphans = set(), []
    for key, req in req_map.items():
        # 订单号或销售单号任一能在明细里找到，就不算漏
        # （不能只看当前这个 key —— 销售单号是 ERP 内部单号，明细里不一定有）
        on = str(req.get("order_no") or "").strip()
        sn = str(req.get("sale_no") or "").strip()
        if (on and on in detail_keys) or (sn and sn in detail_keys):
            continue
        if not on and not sn:
            continue
        sig = (on, sn, req.get("title"), req.get("amount"))
        if sig in seen:
            continue
        seen.add(sig)
        orphans.append(req)
    return orphans


def build_ledger(records, cfg, customers, taxcodes, issued, req_map=None):
    """归一化记录 -> 待开票台账行 + 待补录行"""
    req_map = req_map or {}
    tax_cfg = cfg["tax"]
    rules = cfg["rules"]
    default_rate = float(tax_cfg.get("default_rate", 0.13))
    per_shop = tax_cfg.get("per_shop_rate") or {}
    tax_included = bool(tax_cfg.get("amount_is_tax_included", True))

    skip_status = rules.get("skip_status") or []
    excl_kw = rules.get("exclude_item_keywords") or []
    min_amount = float(rules.get("min_amount", 0) or 0)
    dedupe = bool(rules.get("dedupe_by_order_no", True))

    records = dedupe_cross_source(records)
    amount_records = [r for r in records
                      if str(r.get("商品名称") or "").strip()
                      and not any(s in str(r.get("订单状态") or "") for s in skip_status)
                      and not any(k in str(r.get("商品名称") or "") for k in excl_kw)
                      and (not min_amount or to_num(r.get("金额"), 0) >= min_amount)]
    amount_checks = validate_amounts(amount_records, req_map)

    ledger, missing = [], []

    for rec in records:
        status = str(rec.get("订单状态", ""))
        if any(s in status for s in skip_status):
            continue
        name = str(rec.get("商品名称", ""))
        if not name.strip():
            continue
        if any(k in name for k in excl_kw):
            continue

        order_no = str(rec.get("平台订单号") or rec.get("ERP订单号") or "").strip()
        # 整单已开过票 → 跳过
        if dedupe and any(str(rec.get(k) or "").strip() in issued
                          for k in ("平台订单号", "ERP订单号")):
            continue
        # 跨文件整单去重已完成。同文件的同商品可能有不同规格，必须保留。

        # ---- 税率 ----
        shop = str(rec.get("店铺", ""))
        rate = None
        for k, v in per_shop.items():
            if k and k in shop:
                rate = float(v)
                break
        if rate is None:
            rate = default_rate

        # ---- 抬头 / 税号 ----
        # 优先级：开票申请单（买家自己填的）> 订单文件自带 > 抬头库匹配
        req = req_map.get(order_no)
        if not req:
            req = req_map.get(str(rec.get("ERP订单号", "")).strip())
        hit, mtype = match_customer(rec, customers)

        title = str(rec.get("发票抬头", "")).strip()
        tax_no = str(rec.get("纳税人识别号", "")).strip()
        addr = str(rec.get("购买方地址", "")).strip()
        bank = str(rec.get("购买方开户行", "")).strip()
        bacc = str(rec.get("购买方银行账号", "")).strip()
        email = str(rec.get("交付邮箱", "")).strip()
        title_type, invoice_type, apply_amount = "", "", 0.0

        if req:
            shop = shop or str(req.get("shop") or "").strip()
            if shop != str(rec.get("店铺") or ""):
                for k, v in per_shop.items():
                    if k and k in shop:
                        rate = float(v)
                        break
            title_type = str(req.get("title_type", "")).strip()
            invoice_type = str(req.get("invoice_type", "")).strip()
            apply_amount = float(req.get("amount") or 0)
            title = str(req.get("title") or "").strip() or title
            tax_no = ("" if "个人" in title_type
                      else str(req.get("tax_no") or "").strip() or tax_no)
            email = str(req.get("email") or "").strip() or email
            mtype = "开票申请单"

        if hit:
            title = title or str(hit.get("发票抬头", "")).strip()
            if "个人" not in title_type:
                tax_no = tax_no or str(hit.get("纳税人识别号", "")).strip()
            addr = addr or str(hit.get("地址电话", "")).strip()
            bank = bank or str(hit.get("开户行", "")).strip()
            bacc = bacc or str(hit.get("银行账号", "")).strip()
            email = email or str(hit.get("交付邮箱", "")).strip()
            if not req:
                mtype = mtype or "抬头库"

        # ---- 税收编码 ----
        tc = match_taxcode(name, taxcodes)
        if tc:
            inv_name = str(tc.get("开票商品名称", "")).strip() or name
            tax_code = str(tc.get("税收分类编码", "")).strip()
            unit = str(tc.get("单位", "")).strip() or str(rec.get("单位", "件"))
            spec = str(tc.get("规格型号", "")).strip() or str(rec.get("规格", ""))
            try:
                r2 = float(tc.get("税率"))
                if r2 >= 0:
                    rate = r2
            except (TypeError, ValueError):
                pass
        else:
            inv_name, tax_code = name, ""
            unit = str(rec.get("单位", "件"))
            spec = str(rec.get("规格", ""))

        # ---- 金额 ----
        qty = to_num(rec.get("数量"), 1)
        amount = round(to_num(rec.get("金额"), 0), 2)
        price = round(to_num(rec.get("单价"), 0), 2)
        if not amount and price:
            amount = round(price * qty, 2)
        if min_amount and amount < min_amount:
            continue
        if not price and qty:
            price = round(amount / qty, 6)

        net, tax_amt = split_tax(amount, rate, tax_included)

        # ---- 个人抬头不用税号 / 申请金额与明细金额对账 ----
        personal = "个人" in title_type
        chk = amount_checks.get(order_no) or amount_checks.get(str(rec.get("ERP订单号") or ""))
        if chk and not chk["ok"]:
            check_note = f"申请{chk['req_amount']:.2f} / 明细{chk['detail_sum']:.2f}"
            amount_ok = False
        elif chk:
            check_note = "一致"
            amount_ok = True
        else:
            check_note = ""
            amount_ok = True

        row = OrderedDict([
            ("来源", rec.get("来源", "")),
            ("店铺", shop),
            ("平台订单号", order_no),
            ("ERP订单号", str(rec.get("ERP订单号", "")).strip()),
            ("子订单号", str(rec.get("子订单号", "")).strip()),
            ("买家账号", str(rec.get("买家账号", "")).strip()),
            ("收货人", str(rec.get("收货人", "")).strip()),
            ("手机号", str(rec.get("手机号", "")).strip()),
            ("支付时间", rec.get("支付时间", "")),
            ("商品编码", str(rec.get("商品编码", "")).strip()),
            ("商品名称", name),
            ("开票商品名称", inv_name),
            ("规格型号", spec),
            ("单位", unit or "件"),
            ("数量", qty),
            ("含税单价", round((net + tax_amt) / qty, 8) if qty else 0),
            ("价税合计", round(net + tax_amt, 2)),
            ("不含税金额", net),
            ("税率", rate),
            ("税额", tax_amt),
            ("税收分类编码", tax_code),
            ("发票抬头", title),
            ("纳税人识别号", tax_no),
            ("地址电话", addr),
            ("开户行", bank),
            ("银行账号", bacc),
            ("交付邮箱", email or cfg.get("delivery", {}).get("default_email", "")),
            ("快递公司", str(rec.get("快递公司", "")).strip()),
            ("快递单号", str(rec.get("快递单号", "")).strip()),
            ("买家留言", str(rec.get("买家留言", "")).strip()),
            ("卖家备注", str(rec.get("卖家备注", "")).strip()),
            ("匹配方式", mtype),
            ("抬头类型", title_type),
            ("发票类型", invoice_type),
            ("开票申请来源", str(req.get("req_source", "")) if req else ""),
            ("申请金额", apply_amount),
            ("金额校验", check_note),
            ("来源文件", rec.get("来源文件", "")),
        ])

        # ---- 缺啥记到待补录 ----
        # 分两类：抬头/税号是「按买家补」，税收编码是「按商品全局补」
        problems = []
        buyer_problems = []
        if not title:
            problems.append("缺发票抬头")
            buyer_problems.append("缺发票抬头")
        elif not tax_no and not personal:
            problems.append("缺纳税人识别号")
            buyer_problems.append("缺纳税人识别号")
        if not tax_code:
            problems.append("缺税收分类编码")
        if not amount_ok:
            problems.append("申请金额与明细不符")
        if req and req.get("_conflict"):
            problems.append("同一订单存在冲突的开票申请，请核对后只保留有效申请")
        row["异常标记"] = "；".join(problems)

        if buyer_problems and not bool(rules.get("keep_missing_taxno", True)):
            continue
        if buyer_problems:
            row["待补录原因"] = "；".join(buyer_problems)
            missing.append(row)

        ledger.append(row)

    no_code = sum(1 for r in ledger if "缺税收分类编码" in str(r.get("异常标记", "")))
    return ledger, missing, no_code


def group_invoices(ledger, rules):
    """按 (抬头, 税号, 店铺) 汇总成一张张发票"""
    groups = OrderedDict()
    for r in ledger:
        key = (str(r["发票抬头"]).strip(), str(r["纳税人识别号"]).strip(),
               str(r["店铺"]).strip(), "专用" if "专用" in str(r.get("发票类型", "")) else "普通")
        if not bool(rules.get("merge_same_buyer", True)):
            key = (*key, str(r.get("平台订单号") or r.get("ERP订单号") or ""))
        groups.setdefault(key, []).append(r)

    max_lines = int(rules.get("max_lines_per_invoice", 100) or 100)
    out = OrderedDict()
    for key, rows in groups.items():
        if len(rows) <= max_lines:
            out[key] = rows
        else:
            for i in range(0, len(rows), max_lines):
                out[(*key, f"第{i // max_lines + 1}张")] = rows[i:i + max_lines]
    return out
