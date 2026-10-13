from __future__ import annotations

import json
import hashlib
import re
from decimal import Decimal
from pathlib import Path

from .domain import identity, validate, split_invoices, decimal, money
from .store import dump, fingerprint, uid, now
from .templates import render


class Engine:
    def __init__(self, store):
        self.store = store

    def settings(self):
        return {"seller":self.store.get("seller",{}), "default_rate":self.store.get("default_rate","0.01")}

    def approve_batch(self,bid):
        self.revalidate()
        count=0
        with self.store.connect() as conn:
            for row in self.requests(bid):
                if row["state"] not in ("ready","prepared") or row["problems"]:continue
                conn.execute("INSERT OR REPLACE INTO request_reviews VALUES(?,?,?,?)",(row["id"],row["revision"],fingerprint(row["payload"]),now()))
                conn.execute("INSERT INTO audit VALUES(?,?,?,?,?,?)",(uid(),now(),"batch_review",row["id"],"null",dump({"revision":row["revision"],"batch_id":bid})))
                count+=1
        return count

    def maps(self):
        result = {}
        for row in self.store.rows("SELECT * FROM mappings"):
            result.setdefault(row["kind"],{})[row["map_key"]] = json.loads(row["value"])
        return result

    def ingest(self, batch_id, requests):
        settings, maps = self.settings(), self.maps()
        for raw in requests:
            rid = identity(raw)
            payload, issues = validate(raw, maps, settings)
            h = fingerprint(raw)
            old = self.store.rows("SELECT * FROM requests WHERE id=?",(rid,))
            if old and old[0]["payload_hash"] == h:
                self.store.execute("INSERT OR IGNORE INTO batch_requests VALUES(?,?)", (batch_id,rid))
                continue
            revision = old[0]["revision"] if old else 1
            if old and old[0]["payload_hash"] != h:
                issued = self.store.rows("SELECT id FROM invoices WHERE request_id=? AND state='issued'",(rid,))
                if issued:
                    issues.append({"code":"issued_change","message":"该申请部分或全部已开票，源数据发生变化，请人工核对","item":None})
                else:
                    revision += 1
                    self.store.execute("UPDATE exports SET state='superseded' WHERE batch_id IN (SELECT batch_id FROM batch_requests WHERE request_id=?)",(rid,))
            state = "needs_review" if issues else "ready"
            if old and old[0]["state"] == "issued" and old[0]["payload_hash"] == h:
                state = "issued"
            # 旧库只有订单标识，不能假定整份申请已开：进入核对，避免重复开具。
            for order in raw.get("order_nos",[]):
                if self.store.rows("SELECT order_no FROM legacy_issued WHERE order_no=?",(order,)):
                    payload["legacy_issued"] = True
                    issues.append({"code":"legacy_issued","message":"订单命中旧版已开票记录，请核对申请与原发票","item":None})
                    state = "needs_review"
                    break
            with self.store.connect() as conn:
                conn.execute("INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,payload_hash=excluded.payload_hash,state=excluded.state,problems=excluded.problems,revision=excluded.revision,updated=excluded.updated",
                    (rid,raw.get("account_id","manual"),raw.get("source_id", ""),dump(payload),h,state,dump(issues),revision,now()))
                conn.execute("INSERT OR IGNORE INTO batch_requests VALUES(?,?)",(batch_id,rid))
                if old and old[0]["payload_hash"] != h:
                    conn.execute("INSERT INTO audit VALUES(?,?,?,?,?,?)",(uid(),now(),"source_refresh",rid,old[0]["payload"],dump(payload)))
        return self.summary(batch_id)

    def requests(self, batch_id):
        rows = self.store.rows("SELECT r.* FROM requests r JOIN batch_requests b ON b.request_id=r.id WHERE b.batch_id=? ORDER BY r.updated,r.id",(batch_id,))
        for r in rows:
            r["payload"] = json.loads(r["payload"])
            r["problems"] = json.loads(r["problems"])
        return rows

    def summary(self, batch_id):
        reqs = self.requests(batch_id)
        return {"request_count":len(reqs), "ready_count":sum(r["state"] in ("ready","prepared") for r in reqs),
                "problem_count":sum(r["state"] == "needs_review" for r in reqs),
                "issued_count":sum(r["state"] == "issued" for r in reqs),
                "amount":str(sum((decimal(r["payload"].get("amount","0"),0) for r in reqs if r["state"] in ("ready","prepared")),Decimal(0)))}

    def correct(self, rid, fields, item_index=None):
        allowed = {"title","tax_no","email","address","phone","personal","external_invoice_checked"}
        item_allowed = {"tax_code","rate","unit","invoice_name"}
        rows = self.store.rows("SELECT * FROM requests WHERE id=?",(rid,))
        if not rows:
            raise ValueError("申请不存在")
        row = rows[0]
        if self.store.rows("SELECT id FROM invoices WHERE request_id=? AND state='issued'",(rid,)):
            raise ValueError("该申请已有开票结果，请人工核对，不能直接修改")
        payload = json.loads(row["payload"])
        original = dump(payload)
        if item_index is None:
            if set(fields) - allowed:
                raise ValueError("仅允许补充抬头、税号和交付资料；申请金额请核对源文件")
            if "external_invoice_checked" in fields and fields["external_invoice_checked"] is not True:
                raise ValueError("必须明确确认已核对外部开票记录")
            payload.update(fields)
        else:
            if set(fields) - item_allowed:
                raise ValueError("不能直接修改商品金额或数量")
            item = payload["items"][int(item_index)]
            sku = item.get("sku")
            key = f"{payload['platform']}:{payload['shop_id']}:{sku}" if sku else fingerprint([payload['platform'],payload['shop_id'],item.get('name'),item.get('spec','')])
            self.store.mapping("sku" if sku else "confirmed_item", key, fields)
            item.update(fields)
        # 校验使用原始金额，防止不含税输入被反复加税。
        raw = self._raw(payload)
        if any(p["code"]=="legacy_issued" for p in json.loads(row["problems"])):raw["legacy_issued"]=True
        updated, issues = validate(raw,self.maps(),self.settings())
        with self.store.connect() as conn:
            conn.execute("UPDATE requests SET payload=?,problems=?,state=?,revision=revision+1,updated=? WHERE id=?",
                         (dump(updated),dump(issues),"needs_review" if issues else "ready",now(),rid))
            conn.execute("INSERT INTO audit VALUES(?,?,?,?,?,?)",(uid(),now(),"correction",rid,original,dump(updated)))
            conn.execute("UPDATE exports SET state='superseded' WHERE batch_id IN (SELECT batch_id FROM batch_requests WHERE request_id=?)",(rid,))
        # 商品映射补一次，重新校验全部未开票的关联申请。
        if item_index is not None:
            self.revalidate()

    @staticmethod
    def _raw(payload):
        raw = {**payload,"items":[dict(i) for i in payload.get("items",[])]}
        for i in raw["items"]:
            if "source_amount" in i:
                i["amount"] = i["source_amount"]
        return raw

    def revalidate(self):
        for row in self.store.rows("SELECT * FROM requests WHERE state IN ('needs_review','ready','prepared')"):
            if self.store.rows("SELECT id FROM invoices WHERE request_id=? AND state='issued'",(row["id"],)):
                continue
            raw = self._raw(json.loads(row["payload"]))
            if any(self.store.rows("SELECT order_no FROM legacy_issued WHERE order_no=?",(order,)) for order in raw.get("order_nos",[])):
                raw["legacy_issued"]=True
            account = self.store.rows("SELECT platform FROM accounts WHERE id=?",(row["account_id"],))
            if account and account[0]["platform"] == "jushuitan":
                raw["source_system"] = "jushuitan"
            payload, issues = validate(raw,self.maps(),self.settings())
            changed = dump(payload) != row["payload"] or dump(issues) != row["problems"]
            if changed:
                self.store.execute("UPDATE requests SET payload=?,problems=?,state=?,revision=revision+1,updated=? WHERE id=?",
                                   (dump(payload),dump(issues),"needs_review" if issues else "ready",now(),row["id"]))
                self.store.execute("UPDATE exports SET state='superseded' WHERE batch_id IN (SELECT batch_id FROM batch_requests WHERE request_id=?)",(row["id"],))

    def prepare(self, bid, targets):
        if not self.store.get("seller_confirmed",False):
            raise ValueError("请在资料设置确认销售方名称与适用税率")
        self.revalidate()
        invoices = []
        for row in self.requests(bid):
            if row["state"] not in ("ready","prepared","partially_issued"):
                continue
            parts = split_invoices(row["id"],row["payload"],row["revision"],int(self.store.get("max_lines",100)))
            with self.store.connect() as conn:
                for part in parts:
                    conn.execute("INSERT OR IGNORE INTO invoices(id,request_id,part,revision,payload) VALUES(?,?,?,?,?)",
                                 (part["id"],row["id"],part["part"],part["revision"],dump(part["payload"])))
                if row["state"] != "partially_issued":
                    conn.execute("UPDATE requests SET state='prepared' WHERE id=?",(row["id"],))
            invoices.extend(p for p in parts if not self.store.rows("SELECT id FROM invoices WHERE id=? AND state='issued'",(p["id"],)))
        summary = self.summary(bid)
        opts = self.store.rows("SELECT options FROM batches WHERE id=?",(bid,))
        if opts:
            scope = json.loads(opts[0]["options"]).get("scope")
            if scope:summary["scope"] = scope
        summary["invoice_count"] = len(invoices)
        summary["files"], summary["export_errors"] = [], []
        request_hash = fingerprint([(i["id"],i["payload"]) for i in invoices])
        for target in targets:
            if target not in ("xinfutong","zhejiang"):
                raise ValueError("未知输出格式")
            if not invoices:
                continue
            metadata = self.store.rows("SELECT signature FROM templates WHERE target=?",(target,))
            current_sig = metadata[0]["signature"] if metadata else ""
            old = self.store.rows("SELECT * FROM exports WHERE batch_id=? AND target=? AND request_hash=? AND template_hash=? AND state='prepared'",
                                  (bid,target,request_hash,current_sig))
            checksums = self.store.rows("SELECT sha256 FROM export_artifacts WHERE export_id=?",(old[0]["id"],)) if old else []
            if old and Path(old[0]["path"]).exists() and checksums and hashlib.sha256(Path(old[0]["path"]).read_bytes()).hexdigest()==checksums[0]["sha256"]:
                summary["files"].append({"target":target,"path":old[0]["path"],"verified":False})
                continue
            label = "新福通开票申请单" if target == "xinfutong" else "浙江税务局批量开票"
            dest = self.store.root / "output" / "批次" / bid / "开票文件" / f"{label}_{request_hash[:10]}.xlsx"
            if dest.exists():
                dest = dest.with_name(dest.stem+"_"+uid()[:8]+dest.suffix)
            try:
                sig = render(self.store,target,invoices,dest,self.store.get("seller",{}))
                eid = uid()
                with self.store.connect() as conn:
                    conn.execute("UPDATE exports SET state='superseded' WHERE batch_id=? AND target=? AND state='prepared'",(bid,target))
                    conn.execute("INSERT INTO exports VALUES(?,?,?,?,?,?,?,?)",(eid,bid,target,str(dest),sig,request_hash,"prepared",now()))
                    conn.execute("INSERT INTO export_artifacts VALUES(?,?)",(eid,hashlib.sha256(dest.read_bytes()).hexdigest()))
                summary["files"].append({"target":target,"path":str(dest),"verified":False})
            except Exception as e:
                summary["export_errors"].append({"target":target,"message":str(e)})
        failed = self.store.rows("SELECT * FROM batch_accounts WHERE batch_id=? AND state!='complete'",(bid,))
        summary["incomplete_accounts"] = len(failed)
        state = "partial" if summary["problem_count"] or summary["export_errors"] or failed else "prepared" if invoices else "empty"
        if not summary["files"] and summary["export_errors"]:
            state = "needs_template"
        self.store.update_batch(bid,state,summary)
        manifest = self.store.root / "output" / "批次" / bid / "批次说明.json"
        manifest.parent.mkdir(parents=True,exist_ok=True)
        manifest.write_text(dump({"batch_id":bid,"state":state,"summary":summary,"note":"文件生成不代表已开票；模板需在实际系统试导入验收"}),encoding="utf-8")
        return summary

    def register_results(self, rows):
        # 所有结果先校验，再在一个事务内提交；关联到每个拆分单据。
        pending = {}
        for row in rows:
            iid = str(row.get("开票单单据号") or row.get("单据号") or row.get("bill_no") or "").strip()
            number = str(row.get("发票号码") or row.get("invoice_no") or "").strip()
            if not iid or not number:
                raise ValueError("结果必须包含开票单单据号和发票号码，未登记任何结果")
            inv = self.store.rows("SELECT * FROM invoices WHERE id=?",(iid,))
            if not inv:
                raise ValueError(f"未找到对应开票单据：{iid}")
            if (inv[0]["invoice_no"] and inv[0]["invoice_no"] != number) or (iid in pending and pending[iid] != number):
                raise ValueError(f"单据 {iid} 的发票号码冲突")
            current = self.store.rows("SELECT revision FROM requests WHERE id=?",(inv[0]["request_id"],))[0]
            if current["revision"] != inv[0]["revision"]:
                raise ValueError("结果对应旧版申请，请核对后再登记")
            pending[iid] = number
            duplicates = self.store.rows("SELECT id FROM invoices WHERE invoice_no=? AND id!=?",(number,iid))
            if duplicates or any(k != iid and v == number for k,v in pending.items()):
                raise ValueError("同一发票号码对应多个拆分单据，请核对后登记")
        self.store.backup()
        with self.store.connect() as conn:
            for iid,number in pending.items():
                conn.execute("UPDATE invoices SET state='issued',invoice_no=?,issued_at=? WHERE id=?",(number,now(),iid))
                inv = conn.execute("SELECT request_id,revision FROM invoices WHERE id=?",(iid,)).fetchone()
                left = conn.execute("SELECT COUNT(*) FROM invoices WHERE request_id=? AND revision=? AND state!='issued'",(inv[0],inv[1])).fetchone()[0]
                conn.execute("UPDATE requests SET state=?,updated=? WHERE id=?",("partially_issued" if left else "issued",now(),inv[0]))
                conn.execute("INSERT INTO audit VALUES(?,?,?,?,?,?)",(uid(),now(),"issued_result",iid,"null",dump({"invoice_no":number})))
                conn.execute("UPDATE exports SET state='issued_obsolete' WHERE batch_id IN (SELECT batch_id FROM batch_requests WHERE request_id=?)",(inv[0],))
            conn.execute("UPDATE batches SET state='issued',updated=? WHERE id IN (SELECT batch_id FROM batch_requests GROUP BY batch_id HAVING SUM(CASE WHEN request_id IN (SELECT id FROM requests WHERE state!='issued') THEN 1 ELSE 0 END)=0)",(now(),))
        return len(pending)


def parse_recovery_files(paths, account, complete=True):
    """恢复入口仍以独立开票申请表为权威，不将全店销售单当成申请。"""
    from src.requests import parse_file_full, build_request_map, normalize_request_rows
    from src.readers import read_raw, find_header_row, build_column_map, normalize_rows, _find_alias
    from .columns import column_map, normalized as normalize_header
    details, raw_requests = [], []
    binding=json.loads(account.get("binding") or "{}")
    field_maps=binding.get("field_mapping",{})
    source_platforms = {"聚水潭ERP":"jushuitan","拼多多":"pinduoduo","淘宝天猫":"taobao","京东":"jd"}
    for path in paths:
        if "样例" in Path(path).name:
            raise ValueError("样例文件只能运行旧版测试，不得混入正式采集批次")
        data = read_raw(str(path))
        if not data:
            raise ValueError(f"文件为空：{Path(path).name}")
        hi = find_header_row(data)
        headers,body = data[hi],data[hi+1:]
        info = parse_file_full(str(path))
        matched=[role for role,expected in binding.get("field_mapping_headers",{}).items() if expected==[normalize_header(h) for h in headers]]
        if matched:info["role"]="both" if len(matched)==2 else matched[0]
        if info["role"] in ("detail","both"):
            dmap = column_map(headers,info["source"],overrides=field_maps.get("detail"))
            for rawrow in body:
                recs = normalize_rows([rawrow],dmap,info["source"],Path(path).name)
                if not recs: continue
                rec = recs[0]
                # Reuse legacy aliases, not legacy float arithmetic or zero-as-missing fallback.
                for key,field in (("数量","qty"),("金额","amount"),("单价","price")):
                    col = dmap.get(field)
                    rec[key] = str(rawrow[col] if col is not None and col<len(rawrow) and rawrow[col] is not None else "").strip()
                if "amount" not in dmap and "price" in dmap:
                    try:rec["金额"] = str(money(decimal(rec["单价"])*decimal(rec["数量"])))
                    except ValueError:pass
                rec["_platform"] = source_platforms.get(info["source"],account["platform"])
                details.append(rec)
        # “both”仅在没有独立申请表时才作为恢复候选。
        if info["role"] in ("request","both"):
            cmap = column_map(headers,info["source"],request=True,overrides=field_maps.get("request"))
            for aliases,key in [(["申请单号","开票申请单号","开票申请编号","申请编号","申请ID"],"source_id"),(["店铺编码","店铺ID"],"shop_id"),
                                (["发票号码","发票号"],"source_invoice_no"),(["退款状态","售后状态"],"refund_status"),
                                (["发票状态","开票状态","申请状态"],"status")]:
                if key in field_maps.get("request",{}):continue
                for alias in aliases:
                    hits=[i for i,h in enumerate(headers) if normalize_header(h)==normalize_header(alias)]
                    if len(hits)>1:raise ValueError("重复表头："+alias)
                    col=hits[0] if hits else None
                    if col is not None:
                        cmap[key] = col
                        break
            for raw in body:
                normalized = normalize_request_rows([raw],cmap,info["source"],Path(path).name)
                if not normalized:
                    continue
                req = normalized[0]
                acol = cmap.get("amount")
                req["amount"] = str(raw[acol] if acol is not None and acol<len(raw) and raw[acol] is not None else "").strip()
                for key in ("source_id","shop_id","source_invoice_no","refund_status"):
                    req[key] = str(raw[cmap[key]] or "").strip() if key in cmap and cmap[key]<len(raw) else ""
                req["_role"] = info["role"]
                raw_requests.append(req)
    if any(r["_role"] == "request" for r in raw_requests):
        raw_requests = [r for r in raw_requests if r["_role"] == "request"]
    results = []
    for r in raw_requests:
        status = r.get("status", "")
        from .eligibility import FINISHED
        if status.strip() in FINISHED:
            continue
        platform = source_platforms.get(r.get("platform"),account["platform"])
        if platform == "jushuitan":
            platform = source_platforms.get(r.get("req_source"),"jushuitan")
        shop = r.get("shop") or account.get("name","")
        shop_id = r.get("shop_id") or account.get("shop_id") or shop
        if account["platform"] != "jushuitan":
            if platform != account["platform"]:
                raise ValueError("申请文件平台与所选账号不一致，请按店铺分开采集")
            if r.get("shop_id") and account.get("shop_id") and str(r["shop_id"])!=str(account["shop_id"]):
                raise ValueError("申请文件店铺ID与绑定店铺不一致，禁止跨店串单")
            binding=json.loads(account.get("binding") or "{}")
            if r.get("shop") and binding.get("identity_text") and r["shop"]!=binding["identity_text"]:
                raise ValueError("申请文件店铺名称与绑定身份不一致，请核对账号")
        orders = [v for v in re.split(r"[,，;；\s]+",str(r["order_no"] or "")) if v]
        sales = [str(r.get("sale_no") or "")]
        matching = [d for d in details if (str(d.get("平台订单号")) in orders or (d.get("ERP订单号") and str(d.get("ERP订单号")) in sales))
                    and (not d.get("店铺") or d.get("店铺")==shop)
                    and (d.get("_platform") in (platform,"jushuitan") or account["platform"] == "jushuitan")]
        # Compare duplicates per order across files; different orders may be in separate exports.
        by_order = {}
        for d in matching:
            by_order.setdefault(str(d.get("平台订单号") or d.get("ERP订单号")),{}).setdefault(d["来源文件"],[]).append(d)
        conflict = False
        matching = []
        for files in by_order.values():
            versions = {fingerprint(sorted([{k:d.get(k) for k in ("平台订单号","商品编码","商品名称","规格","数量","金额")} for d in values],key=dump)) for values in files.values()}
            conflict = conflict or len(versions)>1
            matching.extend(next(iter(files.values())))
        items = [{"order_no":str(d.get("平台订单号") or d.get("ERP订单号") or ""), "sku":d.get("商品编码",""),
                  "name":d.get("商品名称",""),"spec":d.get("规格",""),"qty":str(d.get("数量", "")),
                  "amount":str(d.get("金额", "")),"source_amount":str(d.get("金额", "")),"unit":d.get("单位","件"),
                  "source_file":d.get("来源文件","")} for d in matching if d.get("商品名称")]
        results.append({"account_id":account["id"], "platform":platform,"company":account.get("company",""),
            "source_system":account["platform"],"source_status":status,"source_invoice_no":r.get("source_invoice_no",""),
            "refund_status":r.get("refund_status","") if r.get("refund_status","") not in ("无","无退款","无售后","退款关闭","未退款") else "",
            "shop_id":str(shop_id),"shop":shop,"source_id":r["source_id"],"applied_at":r.get("apply_time",""),
            "order_nos":orders or [str(r.get("sale_no") or "")],"title":r.get("title",""),"tax_no":r.get("tax_no",""),
            "email":r.get("email",""),"personal":"个人" in r.get("title_type",""),"invoice_type":r.get("invoice_type","普通"),
            "amount":str(r["amount"]),"items":items,"status":status or "unknown","tax_included":True,
            "collection_complete":complete and bool(items) and set(orders or sales)<=set(i["order_no"] for i in items),"conflict":conflict,"source_file":r.get("req_file","")})
    # 同标识的不同申请数据不可通过最后一条覆盖。
    by_identity = {}
    for req in results:
        rid = identity(req)
        compare = lambda x: {**{k:v for k,v in x.items() if k not in ("source_file","items")},
                              "items":[{k:v for k,v in item.items() if k!="source_file"} for item in x["items"]]}
        if rid in by_identity and fingerprint(compare(by_identity[rid])) != fingerprint(compare(req)):
            by_identity[rid]["conflict"] = True
        else:
            by_identity[rid] = req
    return list(by_identity.values())
