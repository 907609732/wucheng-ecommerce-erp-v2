"""Standalone, fail-closed UI Automation adapter for the installed 千牛 client.

Only connect, invoice navigation, tab selection, query filters and Search are
allowed. No fixed coordinates, cookies, debugging, exports or invoice writes.
The native finance rail has no UIA controls: a local OCR fallback is constrained
to verified navigation labels, followed by trusted invoice-document validation.
"""
import json
import re
import time
from pathlib import Path
from datetime import datetime
from urllib.parse import urlsplit


class NativeCheckError(ValueError):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class NativeAmbiguityError(NativeCheckError):
    pass


class NativeLoginRequiredError(NativeCheckError):
    pass


def select_client_window(windows, process_path, *, identify=None, expected_account=None):
    """Select an exact, process-verified main window, including minimized ones.

    Win32 discovery does not depend on UIA's offscreen/visible state. Login
    windows are evidence for human handoff, never an automation target.
    """
    main, login = [], []
    for window in windows:
        title = window.window_text()
        if title not in ("千牛工作台", "千牛登录"):
            continue
        try:
            exe = process_path(window.process_id())
        except Exception:
            raise NativeCheckError("千牛候选窗口的程序归属无法核实，请确认千牛与巡检程序使用相同的 Windows 用户和权限后重试", "CLIENT_OWNER") from None
        if not exe.replace("/", "\\").lower().endswith("\\aliworkbench.exe"):
            continue
        (main if title == "千牛工作台" else login).append(window)
    if len(main) > 1:
        # Some client versions keep hidden host windows with the same caption.
        # Read identities BEFORE bringing anything forward; never choose the
        # first, largest or foreground window as an account heuristic.
        matches, readable = [], 0
        if identify is not None:
            for window in main:
                try:
                    account = identify(window)
                except Exception:
                    continue
                readable += 1
                if account and (expected_account is None or account == expected_account):
                    matches.append(window)
            if len(matches) == 1:
                return matches[0]
        detail = f"；可识别账号的窗口 {readable} 个，符合目标的窗口 {len(matches)} 个" if identify else ""
        raise NativeAmbiguityError(f"发现 {len(main)} 个千牛工作台窗口{detail}，无法唯一确认目标；请打开已连接店铺的工作台后重试", "CLIENT_MULTIPLE")
    if not main:
        if login:
            raise NativeLoginRequiredError("检测到千牛登录窗口，请手动完成登录并打开目标店铺工作台后重试", "CLIENT_LOGIN")
        raise NativeCheckError("未找到千牛工作台窗口（0 个）；客户端可能已退出、收到托盘或正在重建窗口。请从任务栏或托盘打开目标店铺工作台后重试", "CLIENT_MISSING")
    return main[0]


def finance_target(lines):
    """Find the native rail, not a similarly named page heading or advert.

    Input is WinOCR line/word dictionaries. Require unique, aligned, ordered
    交易 -> 商品 -> 财务 anchors before allowing the finance-only action.
    """
    labels = {label: [] for label in ("交易", "商品", "财务")}
    for line in lines:
        words = line.get("words", [])
        # Windows Chinese OCR may return one word per Chinese character.
        # Only join adjacent words into exact allowlisted labels; no fuzzy text.
        for start in range(len(words)):
            for count in (1, 2):
                selected = words[start:start + count]
                label = re.sub(r"\s+", "", "".join(w.get("text", "") for w in selected))
                # An adjacent native icon can be included in the same OCR word.
                # Accept one leading glyph only, still requiring three exact
                # menu names in the native rail's aligned layout below.
                if len(label) == 3 and label[-2:] in labels:
                    label = label[-2:]
                if label in labels:
                    boxes = [w["bounding_rect"] for w in selected]
                    x = min(float(b["x"]) for b in boxes)
                    y = min(float(b["y"]) for b in boxes)
                    width = max(float(b["x"]) + float(b["width"]) for b in boxes) - x
                    height = max(float(b["y"]) + float(b["height"]) for b in boxes) - y
                    if width > 0 and height > 0:
                        item = (x + width / 2, y + height / 2, height)
                        if item not in labels[label]:
                            labels[label].append(item)
    matches = []
    for finance in labels["财务"]:
        for goods in labels["商品"]:
            for trades in labels["交易"]:
                scale = max(finance[2], goods[2], trades[2])
                if (max(finance[0], goods[0], trades[0]) - min(finance[0], goods[0], trades[0]) <= scale
                        and 0 < goods[1] - trades[1] < scale * 6
                        and scale * 2 < finance[1] - goods[1] < scale * 24):
                    matches.append(finance[:2])
    if len(set(matches)) != 1:
        counts = "，".join(f"{label}{len(items)}处" for label, items in labels.items())
        raise NativeCheckError("无法核实千牛左侧财务导航，请在千牛点击财务后重试；未执行盲点（" + counts + "）")
    return matches[0]


def account_from_names(names):
    ids = set()
    for name in names:
        found = re.fullmatch(r"(tb\d+)(?::[^\r\n]*)?-千牛工作台", name.strip())
        if found:
            ids.add(found[1])
    if len(ids) != 1:
        raise NativeCheckError("无法唯一识别千牛当前账号，请把目标店铺切到前台后连接")
    return ids.pop()


def parse_total(names):
    # Text leaf controls only; ancestor names would duplicate their descendants.
    text = "".join(names)
    hits = re.findall(r"共计\s*(\d+)\s*条(?:记录|申请)", text)
    if len(hits) != 1:
        raise NativeCheckError("无法唯一读取列表总数，不能记为零")
    return int(hits[0])


def invoice_url(value):
    parts = urlsplit(value)
    return (parts.scheme == "https" and parts.hostname == "qn.taobao.com"
            and parts.path == "/home.htm/merchant-invoice/"
            and parts.fragment in ("", "/invoice/apply", "/invoice/agreed"))


class QianniuClient:
    def __init__(self, expected_account=None):
        import win32api
        import win32process
        from pywinauto import Desktop
        def process_path(pid):
            handle = win32api.OpenProcess(0x0410, False, pid)
            try:
                return win32process.GetModuleFileNameEx(handle, 0)
            finally:
                handle.Close()
        windows = Desktop(backend="win32").windows(title_re=r"^千牛(?:工作台|登录)$", visible_only=False)
        uia = Desktop(backend="uia")
        def identify(native):
            window = uia.window(handle=native.handle).wrapper_object()
            return account_from_names([c.window_text() for c in window.descendants(control_type="Pane")])
        native = select_client_window(windows, process_path, identify=identify, expected_account=expected_account)
        # Restore only the unique, verified workbench; never launch a login,
        # click a floating toolbar or choose a different account automatically.
        if native.is_minimized() or not native.is_visible():
            native.restore()
        if not native.is_visible():
            raise NativeCheckError("千牛工作台仍未显示，请从任务栏或托盘打开工作台后重试", "CLIENT_HIDDEN")
        self.window = uia.window(handle=native.handle).wrapper_object()
        self.window.set_focus()

    @staticmethod
    def one(items, description):
        items = list(items)
        if len(items) > 1:
            raise NativeAmbiguityError(description + "存在多个匹配，停止检查")
        if not items:
            raise NativeCheckError("未找到" + description + "，请等待页面加载或检查导航/权限")
        return items[0]

    def identity(self):
        return account_from_names([c.window_text() for c in self.window.descendants(control_type="Pane")])

    def document(self):
        docs = []
        for doc in self.window.descendants(control_type="Document"):
            try:
                value = self.document_value(doc)
            except Exception:
                continue
            if invoice_url(value) and doc.is_visible():
                if not urlsplit(value).fragment:
                    # Entering from Finance opens the root URL, defaulting to
                    # pending applications without a hash. Verify real tabs,
                    # not merely a document that happens to have that URL.
                    tabs = [c.window_text() for c in doc.descendants(control_type="TabItem")]
                    if not all(any(re.fullmatch(re.escape(name) + r"\s*\d*", t) for t in tabs)
                               for name in ("待处理申请", "待录入开票")):
                        continue
                docs.append(doc)
        return self.one(docs, "给买家开票页面")

    @staticmethod
    def document_value(doc):
        try:
            value = doc.iface_value.CurrentValue
        except Exception:
            value = ""
        if not invoice_url(value):
            value = doc.legacy_properties().get("Value", "")
        return value

    def navigation_stage(self, stage):
        callback = getattr(self, "navigation_progress", None)
        if callback:
            callback(stage)

    def invoice_entry(self):
        links = [x for x in self.window.descendants(control_type="Hyperlink")
                 if x.window_text().strip() == "给买家开票" and x.is_visible()]
        if not links:
            return None
        link = self.one(links, "给买家开票入口")
        parts = urlsplit(self.document_value(link))
        if not (parts.scheme == "https" and parts.hostname == "qn.taobao.com"
                and parts.path == "/home.htm/merchant-invoice/"
                and parts.fragment in ("", "/invoice/apply", "/invoice/agreed")):
            raise NativeCheckError("开票入口地址未通过校验，停止导航")
        return link

    def open_finance(self):
        controls = [c for kind in ("Button", "MenuItem", "Hyperlink")
                    for c in self.window.descendants(control_type=kind)
                    if c.window_text().strip() == "财务" and c.is_visible()]
        if controls:
            self.one(controls, "财务导航").click_input()
            return
        self.open_finance_ocr()

    def open_finance_ocr(self):
        # Windows-native OCR via the existing MIT WinOCR package. Only the
        # left navigation rail is processed locally; images/text are not saved.
        try:
            import winocr
            from winrt.windows.globalization import Language
            from winrt.windows.media.ocr import OcrEngine
        except ImportError as exc:
            raise NativeCheckError("本机缺少财务导航识别组件 WinOCR，请更新程序；也可在千牛点击财务后重试") from exc
        if not OcrEngine.is_language_supported(Language("zh-Hans")):
            raise NativeCheckError("Windows 中文文字识别不可用，请先在千牛点击财务后重试")
        import win32gui
        expected = self.identity()
        handle = self.window.handle
        if win32gui.GetForegroundWindow() != handle:
            raise NativeCheckError("千牛不在前台，停止财务导航，请关闭遮挡后重试")
        before = self.window.rectangle()
        image = self.window.capture_as_image()
        # First native rail is narrow; the second web rail may also be present.
        # Aligned peer anchors disambiguate it from the web '财务' heading.
        rail = image.crop((0, 0, min(image.width, 220), image.height))
        # Native rail fonts are ~12px: upscale before Windows OCR. No fuzzy
        # matching and no persisted screenshots or recognized page contents.
        from PIL import Image
        zoom = 3
        rail = rail.resize((rail.width * zoom, rail.height * zoom), Image.Resampling.LANCZOS)
        result = winocr.recognize_pil_sync(rail, "zh-Hans")
        x, y = finance_target(result["lines"])
        x, y = x / zoom, y / zoom
        if self.identity() != expected or self.window.rectangle() != before:
            raise NativeCheckError("识别期间千牛账号或窗口位置改变，停止导航")
        px = before.left + round(x * before.width() / image.width)
        py = before.top + round(y * before.height() / image.height)
        hit = win32gui.WindowFromPoint((px, py))
        if win32gui.GetForegroundWindow() != handle or win32gui.GetAncestor(hit, 2) != handle:
            raise NativeCheckError("财务导航被其他窗口遮挡，停止点击")
        self.window.click_input(coords=(px - before.left, py - before.top))

    def navigate(self):
        expected = self.identity()
        try:
            return self.document()
        except NativeAmbiguityError:
            raise  # Never choose arbitrarily between two invoice pages.
        except NativeCheckError:
            pass
        link = self.invoice_entry()
        if link is None:
            self.navigation_stage("打开财务导航")
            self.open_finance()
            self.navigation_stage("等待财务导航加载")
            def loaded():
                if self.identity() != expected:
                    raise NativeCheckError("导航期间千牛账号改变，停止检查")
                value = self.invoice_entry()
                if value is None:
                    raise NativeCheckError("财务页尚未显示给买家开票入口；请检查加载、登录与发票权限")
                return value
            link = self.wait(loaded)
        if self.identity() != expected:
            raise NativeCheckError("导航期间千牛账号改变，停止检查")
        self.navigation_stage("打开给买家开票")
        link.click_input()
        self.navigation_stage("等待开票页面加载")
        def invoice_loaded():
            if self.identity() != expected:
                raise NativeCheckError("导航期间千牛账号改变，停止检查")
            return self.document()
        return self.wait(invoice_loaded)

    @staticmethod
    def wait(fn, timeout=25):
        deadline = time.monotonic() + timeout
        reason = ""
        while time.monotonic() < deadline:
            try:
                return fn()
            except NativeCheckError as exc:
                reason = str(exc)
                time.sleep(0.4)
        raise NativeCheckError("客户端查询超时：" + reason)

    def form(self):
        # UIA calls HTML tabpanel a Pane with localized control type; use the
        # actual date/filter controls to scope the query, never the global Search.
        doc = self.document()
        date = self.one((c for c in doc.descendants(control_type="Edit")
                         if c.window_text() == "起始日期" and c.is_visible()), "起始日期")
        scope = date
        for _ in range(10):
            scope = scope.parent()
            edits = [c for c in scope.descendants(control_type="Edit") if c.is_visible()]
            if {"起始日期", "结束日期", "订单编号", "发票抬头"}.issubset({c.window_text() for c in edits}):
                return scope
        raise NativeCheckError("无法定位申请查询表单")

    def snapshot(self):
        doc = self.document()
        # Current document accessibility includes off-screen rows (e.g. the
        # empty-state below a short window). Do not mistake clipping for no data.
        leaves = doc.descendants(control_type="Text")
        names = [c.window_text() for c in leaves]
        total = parse_total(names)
        # Result UI nodes are recreated by this client's fresh query, including
        # the zero-result '没有数据' node. Unchanged nodes cannot prove freshness.
        signatures = tuple(tuple(c.element_info.runtime_id) for c in leaves
                           if c.window_text() == "没有数据" or re.fullmatch(r"\d{12,30}", c.window_text()))
        if not signatures:
            raise NativeCheckError("未读到结果行或明确空列表")
        if any("加载中" in s or "网络异常" in s or "请求失败" in s for s in names):
            raise NativeCheckError("查询未完成或网络异常")
        return total, signatures

    def query(self, tab, expected_account):
        if self.identity() != expected_account:
            raise NativeCheckError("当前账号与绑定账号不同，停止检查，不自动切换其他账号")
        target = self.one((c for c in self.document().descendants(control_type="TabItem")
                           if re.fullmatch(re.escape(tab) + r"\s*\d*", c.window_text()) and c.is_visible()), tab)
        # Chromium's SelectionItem changes accessibility selection without
        # firing this page's React click handler. Click the verified UIA control.
        target.click_input()
        expected_fragment = "/invoice/apply" if tab == "待处理申请" else "/invoice/agreed"
        def loaded():
            doc = self.document()
            fragment = urlsplit(self.document_value(doc)).fragment
            root_pending = (not fragment and tab == "待处理申请"
                            and bool(target.iface_selection_item.CurrentIsSelected))
            if fragment != expected_fragment and not root_pending:
                raise NativeCheckError("标签切换中")
            return self.form()
        form = self.wait(loaded)
        def field(name):
            return self.one((c for c in form.descendants(control_type="Edit")
                             if c.window_text() == name and c.is_visible()), name)
        for name in ("订单编号", "发票抬头"):
            edit = field(name)
            if edit.get_value():
                edit.set_edit_text("")
                if edit.get_value():
                    raise NativeCheckError("无法清除订单或抬头筛选")
        from invoice_watch import CN
        end = field("结束日期")
        today = datetime.now(CN).date().isoformat()
        if end.get_value() != today:
            end.set_edit_text(today)
        dates = [field(name).get_value() for name in ("起始日期", "结束日期")]
        if dates[1] != today or any(not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in dates):
            raise NativeCheckError("日期未更新至今天，请在客户端设置查询范围后重试")
        combos = form.descendants(control_type="ComboBox")
        for combo in combos:
            if combo.is_visible() and combo.window_text().strip() not in ("", "状态", "请选择", "状态 请选择"):
                raise NativeCheckError("存在其他状态筛选，请重置筛选后重试")
        before = self.wait(self.snapshot)
        search = self.one((c for c in form.descendants(control_type="Button")
                           if c.window_text() == "搜索" and c.is_visible()), "表单搜索")
        search.iface_invoke.Invoke()
        def fresh():
            value = self.snapshot()
            if value[1] == before[1]:
                raise NativeCheckError("尚未确认新查询结果")
            time.sleep(0.5)
            if self.snapshot() != value:
                raise NativeCheckError("查询结果仍在变化")
            if self.identity() != expected_account:
                raise NativeCheckError("查询期间账号改变")
            return value[0]
        return self.wait(fresh), dates


def native_worker(root, connect=False, client_factory=QianniuClient, run_id=None):
    import uuid
    from invoice_watch import record, validate_observation
    from .watch_runtime import config, save_config
    from .watch_logs import append_log, exception_location, safe_text
    settings = config(root)
    run_id = run_id or uuid.uuid4().hex
    current = {"stage": "初始化", "code": "INITIALIZE"}
    append_log(root, "INFO", "开始连接" if connect else "开始检查", "仅操作已登录千牛客户端；不开票、不导出、不回传。", run_id=run_id)
    def progress(stage):
        current.update(stage=stage, code={"连接千牛窗口": "CLIENT_WINDOW", "识别当前账号": "CLIENT_IDENTITY",
                       "打开财务导航": "NAV_FINANCE", "等待财务导航加载": "NAV_FINANCE_WAIT",
                       "打开给买家开票": "NAV_INVOICE", "等待开票页面加载": "NAV_INVOICE_WAIT",
                       "定位给买家开票页面": "INVOICE_PAGE", "查询待处理申请": "QUERY_PENDING",
                       "查询待录入开票": "QUERY_UNRECORDED", "核对查询范围": "QUERY_SCOPE"}.get(stage, "CLIENT_OPERATION"))
        append_log(root, "INFO", stage, "正在执行" if stage not in ("已连接", "检查完成", "检查失败") else stage, run_id=run_id)
        Path(root).mkdir(parents=True, exist_ok=True)
        (Path(root) / "native-progress.json").write_text(json.dumps({"stage": stage}, ensure_ascii=False), encoding="utf-8")
    outcome = {"shop": settings["shop"], "outcome": "error", "coverage": "unknown",
               "pending_count": None, "unrecorded_count": None, "source": "qianniu_client"}
    try:
        progress("连接千牛窗口")
        client = (client_factory(expected_account=None if connect else settings.get("native_account"))
                  if client_factory is QianniuClient else client_factory())
        progress("识别当前账号")
        account = client.identity()
        if connect:
            # The account ID is NOT a numeric shop ID or a legal seller identity.
            settings.update(native_account=account, source="qianniu_client", shop="千牛账号 " + account)
            save_config(root, settings)
            progress("已连接")
            result = {"connected": True, "message": "已连接当前千牛账号", "account": account, "run_id": run_id}
            print(json.dumps(result, ensure_ascii=False), flush=True)
            return result
        expected = settings.get("native_account")
        if not expected:
            raise NativeCheckError("首次使用请点击连接已登录千牛，自动读取当前账号，无需填写别名")
        if account != expected:
            raise NativeCheckError("千牛当前账号与已连接账号不同，请手动切回目标店铺后重试")
        progress("定位给买家开票页面")
        client.navigation_progress = progress
        client.navigate()
        progress("查询待处理申请")
        pending, scope1 = client.query("待处理申请", expected)
        append_log(root, "INFO", "待处理申请结果", f"本次实时查询共 {pending} 条申请。", run_id=run_id)
        progress("查询待录入开票")
        unrecorded, scope2 = client.query("待录入开票", expected)
        append_log(root, "INFO", "待录入开票结果", f"本次实时查询共 {unrecorded} 条申请。", run_id=run_id)
        progress("核对查询范围")
        if scope1 != scope2:
            raise NativeCheckError("两个列表查询范围不同，不能混合统计")
        outcome.update(outcome="observed", coverage="visible_range", fresh_query=True,
                       pending_count=pending, unrecorded_count=unrecorded,
                       scope_start=scope1[0], scope_end=scope1[1], message="直接读取已登录千牛客户端")
        validate_observation(outcome)
    except Exception as exc:
        message = safe_text(exc) if isinstance(exc, NativeCheckError) else "客户端控件不可读或查询失败，请保持千牛已登录、桌面解锁并打开给买家开票页面重试"
        code = exc.code if isinstance(exc, NativeCheckError) and exc.code else current["code"]
        append_log(root, "ERROR", current["stage"], message + "；" + exception_location(exc),
                   run_id=run_id, code=code)
        outcome.update(outcome="needs_login" if isinstance(exc, NativeLoginRequiredError) else "error",
                       coverage="unknown", pending_count=None,
                       unrecorded_count=None, message=message, error_code=code)
    outcome["run_id"] = run_id
    result = record(root, outcome)
    if result["outcome"] == "observed":
        append_log(root, "INFO", "检查结果", f"待处理 {pending} 条；待录入 {unrecorded} 条；范围 {scope1[0]} 至 {scope1[1]}。仅当前日期范围，待录入不等于尚未开具。", run_id=run_id)
    progress("检查完成" if result["outcome"] == "observed" else "需要登录" if result["outcome"] == "needs_login" else "检查失败")
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result
