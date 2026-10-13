"""Fail-closed recognition of explicitly labelled shop identity on visible pages.

No cookies, hidden application state or undocumented API are read. Real platform
layouts still need acceptance; unsupported pages must never produce a guessed ID.
"""
import json
import re
from urllib.parse import urlsplit, urlunsplit

HOSTS = {"taobao": ("taobao.com", "tmall.com"),
         "pinduoduo": ("pinduoduo.com",), "jd": ("jd.com",)}


def trusted_url(platform, url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.username or parts.password:
        return False
    host = (parts.hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in HOSTS.get(platform, ()))


def labelled(text, labels, value_pattern):
    label = "(?:" + "|".join(re.escape(x) for x in labels) + ")"
    # Labels must begin a line, preventing a buyer field / arbitrary URL match.
    pattern = rf"(?im)^\s*{label}[ \t]*[：:]?[ \t]*(?:\n[ \t]*)?({value_pattern})[ \t]*$"
    return set(re.findall(pattern, text))


def recognize(platform, snapshots):
    candidates = []
    for snapshot in snapshots:
        if not trusted_url(platform, snapshot["url"]):
            continue
        text = snapshot["text"].replace("\r\n", "\n")
        if re.search(r"扫码登录|密码登录|请先登录", text):
            continue
        names = labelled(text, ("店铺名称", "店铺名"), r"[^\n：:]{1,100}")
        ids = labelled(text, ("店铺ID", "店铺 ID", "店铺编号"), r"[0-9]{1,30}")
        if len(names) > 1 or len(ids) > 1:
            raise ValueError("页面存在多个店铺身份，无法唯一识别；请打开当前店铺的信息页")
        if names and ids:
            parts = urlsplit(snapshot["url"])
            candidates.append({"name": next(iter(names)).strip(), "shop_id": next(iter(ids)),
                               "source_url": urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))})
    if len({(c["name"], c["shop_id"]) for c in candidates}) > 1:
        raise ValueError("已打开的后台页面店铺身份不一致，请关闭其他店铺页面后重试")
    return candidates[0] if candidates else None


def bind_recognized(store, account_id, identity):
    account = store.rows("SELECT * FROM accounts WHERE id=?", (account_id,))
    if not account:
        raise ValueError("账号不存在")
    account = account[0]
    name, shopid = identity.get("name", "").strip(), identity.get("shop_id", "")
    if not name or not re.fullmatch(r"[0-9]{1,30}", shopid) or not trusted_url(account["platform"], identity.get("source_url", "")):
        raise ValueError("未获得可信后台的完整店铺名称与ID")
    if account["shop_id"] and account["shop_id"] != shopid:
        raise ValueError("当前登录店铺与原绑定ID不一致，已停止；不会覆盖原店铺")
    duplicates = store.rows("SELECT id FROM accounts WHERE platform=? AND shop_id=? AND id!=?",
                            (account["platform"], shopid, account_id))
    if duplicates:
        raise ValueError("此店铺已存在，请使用原有店铺连接，避免重复添加")
    binding = json.loads(account["binding"])
    binding.update(identity_text=name, identity_source="visible_labels", identity_verified=True,
                   identity_url=identity["source_url"])
    # company is a data-isolation namespace, never an inferred legal/tax entity.
    company = account["company"] or f'{account["platform"]}:{shopid}'
    from .store import dump, now
    with store.connect() as conn:
        conn.execute("UPDATE accounts SET name=?,company=?,shop_id=?,binding=?,state='complete',updated=? WHERE id=?",
                     (name, company, shopid, dump(binding), now(), account_id))
    store.audit("shop_identity", account_id,
                {"name": account["name"], "shop_id": account["shop_id"]},
                {"name": name, "shop_id": shopid, "source": "visible_labels"})
