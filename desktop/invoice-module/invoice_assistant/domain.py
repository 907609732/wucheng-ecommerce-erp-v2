from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from .store import fingerprint
from .eligibility import eligibility_issues

CENT = Decimal("0.01")


def decimal(value, default=None):
    try:
        result = Decimal(str(value).replace(",", "").replace("¥", "").strip())
        if not result.is_finite():
            raise ValueError("金额或数量不能是无穷或非数值")
        return result
    except (InvalidOperation, ValueError, TypeError):
        if default is not None:
            return Decimal(str(default))
        raise ValueError(f"无法识别数字：{value}")


def money(value):
    return decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def identity(req):
    base = [req.get("company", ""), req["platform"], req["shop_id"]]
    if req.get("source_id"):
        return fingerprint(base + [str(req["source_id"])])
    if req.get("applied_at") and req.get("order_nos"):
        return fingerprint(base + [sorted(req["order_nos"]), req["applied_at"]])
    # 临时标识只供展示问题；缺少稳定标识的申请禁止导出。
    return fingerprint(base + ["unresolved", req.get("order_nos", []), req.get("title"), req.get("amount")])


def validate(req, maps, settings):
    req = {**req, "items": [dict(i) for i in req.get("items", [])]}
    issues = eligibility_issues(req)
    def issue(code, text, item=None):
        issues.append({"code": code, "message": text, "item": item})
    if not req.get("source_id") and not (req.get("applied_at") and req.get("order_nos")):
        issue("identity", "申请缺少稳定编号或申请时间，请核对原申请")
    if not req.get("shop_id") or not req.get("platform"):
        issue("shop", "缺少平台或店铺身份，请重新绑定")
    if not req.get("collection_complete", False):
        issue("incomplete", "采集完整性尚未确认，请补齐对应订单明细")
    if req.get("conflict"):
        issue("conflict", "同一申请存在冲突版本，请核对原始导出")
    if req.get("legacy_issued"):
        issue("legacy_issued", "订单命中旧版已开票记录，请核对申请与原发票")
    if not req.get("title"):
        issue("title", "请填写发票抬头")
    personal = req.get("personal", False)
    if not personal and not req.get("tax_no"):
        issue("tax_no", "企业申请缺少税号")
    if not settings.get("seller", {}).get("name"):
        issue("seller", "请在资料设置填写销售方名称")
    if not req["items"]:
        issue("items", "找不到申请对应的商品明细")
    covered = {str(i.get("order_no", "")) for i in req["items"]}
    if set(map(str,req.get("order_nos",[]))) - covered:
        issue("order_coverage", "申请包含的部分订单缺少明细，整份申请暂不导出")
    total = Decimal(0)
    for index, item in enumerate(req["items"]):
        item.setdefault("source_amount", item.get("amount", ""))
        sku = str(item.get("sku") or "")
        mapping = maps.get("sku", {}).get(f"{req['platform']}:{req['shop_id']}:{sku}") if sku else None
        if not mapping:
            mapping = maps.get("confirmed_item", {}).get(fingerprint([req["platform"], req["shop_id"], item.get("name"), item.get("spec", "")]))
        if mapping:
            for key in ("tax_code", "rate", "unit", "invoice_name"):
                if mapping.get(key) not in (None, ""):
                    item[key] = mapping[key]
        item.setdefault("invoice_name", item.get("name", ""))
        item.setdefault("unit", "件")
        if not item.get("name"):
            issue("item_name", "商品名称缺失", index)
        tax_code = str(item.get("tax_code") or "")
        if len(tax_code) != 19 or not tax_code.isdigit():
            issue("tax_code", "请确认并填写19位税收分类编码", index)
        try:
            qty = decimal(item.get("qty", ""))
            amount = money(item.get("source_amount", ""))
            rate = decimal(item.get("rate", settings.get("default_rate", "0.01")))
            if qty <= 0 or amount <= 0:
                issue("positive", "数量与金额必须大于0；退款、红字业务需另行处理", index)
            if rate < 0 or rate > 1:
                issue("rate", "税率无效", index)
            included = req.get("tax_included", True)
            net = money(amount / (1 + rate)) if included else amount
            gross = amount if included else money(net * (1 + rate))
            tax = gross - net
            item.update(qty=str(qty), amount=str(gross), net=str(net), tax=str(tax), rate=str(rate),
                        price=str((gross / qty).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)) if qty else "0")
            total += gross
        except (ValueError, InvalidOperation, ZeroDivisionError):
            issue("number", "数量、金额或税率格式无效", index)
    try:
        expected = money(req.get("amount", ""))
        if expected <= 0:
            issue("amount", "申请金额必须大于0")
        if total != expected:
            issue("amount_mismatch", f"申请 ¥{expected:.2f} / 明细 ¥{total:.2f} / 差额 ¥{total-expected:.2f}")
    except ValueError:
        issue("amount", "缺少有效申请金额")
    req["detail_total"] = str(total)
    return req, issues


def split_invoices(request_id, req, revision, limit=100):
    if limit < 1:
        raise ValueError("单张票明细上限必须大于0")
    invoices = []
    for start in range(0, len(req["items"]), limit):
        part = start // limit + 1
        # 全国数电模板流水号上限20字符，两种格式统一使用同一标识。
        iid = "FP" + fingerprint([request_id, revision, part])[:18].upper()
        items = req["items"][start:start+limit]
        payload = {**req, "items": items, "bill_no": iid,
                   "amount": str(sum((decimal(i["amount"]) for i in items), Decimal(0)))}
        invoices.append({"id": iid, "part": part, "revision": revision, "payload": payload})
    return invoices
