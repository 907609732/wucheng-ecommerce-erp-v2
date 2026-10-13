"""In-process daily scheduling and read-only merchant browser worker. No Codex."""
from datetime import datetime, timedelta
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlparse

DEFAULT = {"enabled": True, "time": "20:00", "shop": "店口五金店", "source": "qianniu_client"}


def config(root):
    path = Path(root) / "schedule.json"
    return {**DEFAULT, **(json.loads(path.read_text(encoding="utf-8")) if path.exists() else {})}


def save_config(root, value):
    datetime.strptime(value["time"], "%H:%M")
    path = Path(root) / "schedule.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def claim_due(root, settings, now):
    """Atomically claim once per China-local day; resume after sleep, no retry storm."""
    if not settings["enabled"] or now.strftime("%H:%M") < settings["time"]:
        return False
    Path(root).mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(Path(root) / "schedule.sqlite3", timeout=10)) as conn, conn:
        conn.execute("CREATE TABLE IF NOT EXISTS runs(day TEXT PRIMARY KEY, claimed_at TEXT)")
        cursor = conn.execute("INSERT OR IGNORE INTO runs VALUES(?,?)", (now.date().isoformat(), now.isoformat()))
        return cursor.rowcount == 1


def next_due(settings, now):
    if not settings["enabled"]:
        return "已暂停"
    hour, minute = map(int, settings["time"].split(":"))
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target.strftime("%Y-%m-%d %H:%M")


def parse_count(text):
    matches = re.findall(r"共(?:计)?\s*(\d+)\s*(?:条记录|条申请)", text)
    if len(matches) != 1:
        raise ValueError("无法唯一确认申请总数，未将页面视为零")
    return int(matches[0])


def browser_worker(root, login=False):
    """Only formal page filters; never approve, export, upload or issue invoices.

    This independent browser route requires real-account acceptance. Native 千牛
    login is not copied. Ambiguous DOM, identity or scope fails closed.
    """
    from playwright.sync_api import sync_playwright
    from invoice_watch import CN, record
    settings = config(root)
    shop = settings["shop"]
    outcome = {"shop": shop, "outcome": "error", "coverage": "unknown",
               "pending_count": None, "unrecorded_count": None}
    try:
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                str(Path(root) / "BrowserProfile"), channel="chrome", headless=False,
                accept_downloads=False, viewport={"width": 1440, "height": 960})
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto("https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/agreed",
                          wait_until="domcontentloaded", timeout=45000)
                if login:
                    # Keep visible for user-operated QR/verification. No password capture.
                    until = time.monotonic() + 180
                    while time.monotonic() < until and ctx.pages:
                        page.wait_for_timeout(1000)
                    return
                host = urlparse(page.url).hostname or ""
                if host != "qn.taobao.com":
                    outcome["outcome"] = "needs_login"
                    raise ValueError("专用浏览器需要登录或授权，请点击登录店铺；不会复制千牛登录状态")
                frames = [f for f in page.frames if urlparse(f.url).hostname == "qn.taobao.com"]
                targets = []
                for frame in frames:
                    body = frame.locator("body").inner_text(timeout=5000)
                    if "给买家开票" in body and "待录入开票" in body:
                        targets.append(frame)
                if len(targets) != 1:
                    outcome["outcome"] = "needs_login"
                    raise ValueError("未找到可读取的发票申请页面，请登录；登录后仍失败则需要验收页面适配")
                frame = targets[0]
                body = frame.locator("body").inner_text()
                if shop not in body:
                    raise ValueError("无法确认目标店铺身份，已停止；不会读取其他店铺")
                # Identify existing form controls from their visible placeholders only.
                for placeholder in ("订单编号", "发票抬头"):
                    field = frame.get_by_placeholder(placeholder, exact=True)
                    if field.count() != 1 or not field.is_visible():
                        raise ValueError("筛选输入框结构尚未验收，停止查询")
                    field.fill("")
                counts, scopes = [], []
                for tab in ("待处理申请", "待录入开票"):
                    locator = frame.get_by_text(re.compile(r"^" + tab + r"\s*\d*$"))
                    if locator.count() != 1 or not locator.is_visible():
                        raise ValueError("申请标签结构不明确，停止查询")
                    locator.click(timeout=5000)
                    # The date values must be actual form inputs, not text elsewhere.
                    values = frame.locator("input").evaluate_all("es => es.filter(e=>e.getClientRects().length).map(e=>e.value)")
                    dates = [v for v in values if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v)]
                    if len(dates) != 2:
                        raise ValueError("无法确认实际查询日期，停止；不默认全部历史")
                    scopes.append(dates)
                    search = frame.get_by_role("button", name="搜索", exact=True)
                    if search.count() != 1:
                        raise ValueError("搜索按钮不唯一，停止查询")
                    # Prove a fresh completed query using the browser's loading UI.
                    loading = frame.locator(".ant-spin-spinning:visible, .next-loading:visible")
                    if loading.count():
                        loading.first.wait_for(state="hidden", timeout=15000)
                    search.click(timeout=5000)
                    try:
                        loading.first.wait_for(state="visible", timeout=5000)
                        loading.first.wait_for(state="hidden", timeout=30000)
                    except Exception:
                        raise ValueError("未能确认本次查询加载完成，不能沿用旧数量")
                    counts.append(parse_count(frame.locator("body").inner_text()))
                if scopes[0] != scopes[1]:
                    raise ValueError("两类申请日期范围不同，不能混合统计")
                outcome.update(outcome="observed", coverage="visible_range", fresh_query=True,
                               pending_count=counts[0], unrecorded_count=counts[1],
                               scope_start=scopes[0][0], scope_end=scopes[0][1], message="")
            finally:
                ctx.close()
    except Exception as exc:
        # Avoid logging raw browser exceptions which can contain URLs/tokens.
        message = str(exc) if isinstance(exc, ValueError) else "浏览器连接、页面查询或网络失败，请登录后重试；独立采集尚待真实验收"
        outcome.update(message=message, pending_count=None, unrecorded_count=None, coverage="unknown")
        if outcome["outcome"] == "observed":
            outcome["outcome"] = "error"
    if not login:
        result = record(root, outcome)
        print(json.dumps(result, ensure_ascii=False), flush=True)
