"""Visible, isolated merchant-browser collection. Never infer success from an empty page."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

from .engine import parse_recovery_files

PLATFORMS = {
    "jushuitan": {"name":"聚水潭", "url":"https://erp321.com/epaas", "menus":["开票申请","发票管理"], "hosts":["erp321.com","jushuitan.com"]},
    "pinduoduo": {"name":"拼多多", "url":"https://mms.pinduoduo.com/", "menus":["开票管理","发票管理"], "hosts":["pinduoduo.com"]},
    "taobao": {"name":"淘宝天猫", "url":"https://qn.taobao.com/", "menus":["发票管理","开票管理"], "hosts":["taobao.com","tmall.com"]},
    "jd": {"name":"京东", "url":"https://shop.jd.com/", "menus":["发票管理","开票管理"], "hosts":["jd.com"]},
}


class CollectionError(Exception):
    def __init__(self, state, message):
        super().__init__(message)
        self.state = state


def profile_dir(account_id, channel="chrome"):
    base = Path(os.environ.get("LOCALAPPDATA", str(Path.home()/"AppData"/"Local")))
    return base / "WuchengInvoiceAssistant" / "BrowserProfiles" / hashlib.sha256((channel+":"+account_id).encode()).hexdigest()[:24]


def event(kind, **values):
    print(json.dumps({"kind":kind, **values}, ensure_ascii=False), flush=True)


class MerchantAdapter:
    def __init__(self, account, folder, emit=event):
        self.account, self.folder, self.emit = account, Path(folder), emit
        self.spec = PLATFORMS[account["platform"]]
        self.binding = json.loads(account.get("binding") or "{}")
        self.folder.mkdir(parents=True,exist_ok=True)

    def check_host(self, page):
        from urllib.parse import urlparse
        host = urlparse(page.url).hostname or ""
        if not any(host == h or host.endswith("."+h) for h in self.spec["hosts"]):
            raise CollectionError("needs_verification","后台跳转到了未确认域名，请检查浏览器；未采集任何数据")

    @staticmethod
    def click_text(page, texts):
        for frame in page.frames:
            for name in texts:
                loc = frame.get_by_text(name,exact=True)
                if loc.count() == 1 and loc.is_visible():
                    loc.click(timeout=8000)
                    return True
        return False

    @staticmethod
    def export_kinds(recipe):
        """A verified combined export needs one download, not a duplicate click.

        Layout is part of the verified recipe; never infer it from a filename.
        Parsing still proves request/order coverage after the download.
        """
        layout = recipe.get("export_layout", "separate")
        if layout == "combined":
            kinds = ("request_export",)
        elif layout == "separate":
            kinds = ("request_export", "detail_export")
        else:
            raise CollectionError("needs_verification", "未识别的后台导出布局，请重新验收采集配置")
        if not all(isinstance(recipe.get(k), str) and recipe[k].strip() for k in kinds):
            raise CollectionError("needs_verification", "正式导出按钮尚未实测绑定，未启动下载")
        return kinds

    def download_files(self, page, recipe):
        paths = []
        for kind in self.export_kinds(recipe):
            with page.expect_download(timeout=120000) as download:
                if not self.click_text(page, [recipe[kind]]):
                    raise CollectionError("failed", "找不到已绑定的正式导出按钮，后台可能改版或权限不足")
            dl = download.value
            if dl.failure():
                raise CollectionError("failed", "后台导出下载失败")
            filename = Path(dl.suggested_filename).name
            dest = self.folder / (kind + "_" + filename)
            if dest.exists():
                raise CollectionError("needs_verification", "本批次已有同名下载文件，请核对检查点，未覆盖原文件")
            dl.save_as(dest)
            paths.append(str(dest))
        return paths

    def collect(self, connect_only=False):
        if self.account["platform"] == "jushuitan":
            raise CollectionError("needs_verification","聚水潭采集已暂停：申请记录不能证明当前待开票，请使用电商平台模式")
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                channel = self.binding.get("browser_channel", "chrome")
                if channel not in ("chrome", "msedge"):
                    raise ValueError("unsupported browser")
                ctx = pw.chromium.launch_persistent_context(str(profile_dir(self.account["id"],channel)),channel=channel,
                    headless=False,accept_downloads=True,viewport={"width":1440,"height":960})
            except Exception:
                raise CollectionError("failed","专用浏览器启动失败：请检查 Chrome/Edge 安装，关闭该账号的助手窗口后重试")
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto(self.spec["url"],wait_until="domcontentloaded",timeout=60000)
                self.emit("stage",stage="连接后台",account_id=self.account["id"])
                self.emit("browser_ready",account_id=self.account["id"],message="浏览器已打开；需要扫码、验证码时请在浏览器完成")
                from .shop_identity import recognize, trusted_url
                deadline = time.monotonic()+180
                announced = False
                previous = None
                while time.monotonic()<deadline:
                    snapshots = []
                    for candidate_page in ctx.pages:
                        for frame in candidate_page.frames:
                            if trusted_url(self.account["platform"], frame.url):
                                try:
                                    snapshots.append({"url":frame.url,"text":frame.locator("body").inner_text(timeout=3000)})
                                except Exception:
                                    continue  # Navigation in progress is not an identity proof.
                    try:
                        found = recognize(self.account["platform"], snapshots)
                    except ValueError as e:
                        raise CollectionError("needs_verification",str(e))
                    if found:
                        if self.account["shop_id"] and found["shop_id"] != self.account["shop_id"]:
                            raise CollectionError("needs_verification","当前登录店铺ID与原绑定不一致，已停止，未覆盖店铺")
                        if previous and (found["name"],found["shop_id"]) == (previous["name"],previous["shop_id"]):
                            break
                    previous = found
                    if not announced:
                        self.emit("needs_login",account_id=self.account["id"],message="请扫码登录；登录后请打开店铺信息页，程序自动读取明确标注的店铺名称和ID，无需手填")
                        announced = True
                    page.wait_for_timeout(1200)
                else:
                    raise CollectionError("needs_verification","未自动读到完整店铺名称和ID；请登录后打开店铺信息页再连接，不能猜填或仅按昵称绑定")
                self.account.update(name=found["name"],shop_id=found["shop_id"])
                self.emit("connected",account_id=self.account["id"],identity=found,
                          message="已自动读取店铺身份；订单采集路径仍需单独验收")
                if connect_only:
                    return None
                page = next((p for p in ctx.pages if trusted_url(self.account["platform"],p.url)),page)
                self.check_host(page)
                self.emit("stage",stage="获取申请",account_id=self.account["id"])
                self.click_text(page,self.spec["menus"])
                page.wait_for_timeout(1500)
                self.click_text(page,["待开票","未开票"])
                page.wait_for_timeout(1200)
                # A verified UI recipe is intentionally separate from platform identity. Page changes invalidate it.
                recipe = self.binding.get("recipe") or {}
                required = ("pending_marker","pending_selected_selector","scope_marker","count_pattern")
                if not all(recipe.get(k) for k in required):
                    raise CollectionError("needs_verification","已进入后台，但待开票筛选、全量范围和导出路径尚未实测绑定；不能把当前列表视作全部申请")
                self.export_kinds(recipe)
                texts = "\n".join(f.locator("body").inner_text() for f in page.frames)
                if recipe["pending_marker"] not in texts or recipe["scope_marker"] not in texts:
                    raise CollectionError("needs_verification","待开票筛选或查询范围与已验收配置不符，请核对后台查询条件")
                # A label appearing somewhere in navigation is not proof the pending filter is active.
                selected = [f.locator(recipe["pending_selected_selector"]) for f in page.frames]
                selected = [loc for loc in selected if loc.count()==1 and loc.is_visible()]
                if len(selected)!=1 or selected[0].inner_text().strip()!=recipe["pending_marker"]:
                    raise CollectionError("needs_verification","未确认待开票筛选处于选中状态，不能将其他列表视为待开票申请")
                counts = re.findall(recipe["count_pattern"],texts)
                if len(counts)!=1:
                    raise CollectionError("needs_verification","不能唯一确认后台申请总数，未标记采集完成")
                expected_count = int(counts[0])
                scope = recipe["scope_marker"]
                if expected_count == 0:
                    return {"requests":[],"files":[],"evidence":{"count":0,"scope":scope,"identity_confirmed":True,"complete":True}}
                paths = self.download_files(page, recipe)
                requests = parse_recovery_files(paths,self.account,complete=True)
                if len(requests)!=expected_count or any(not r["collection_complete"] or r["conflict"] for r in requests):
                    raise CollectionError("incomplete","申请数量、关联订单或跨文件明细无法对账；文件已保留但禁止完整成功")
                evidence = {"count":expected_count,"scope":scope,"identity_confirmed":True,"complete":True,
                    "files":[{"name":Path(p).name,"sha256":hashlib.sha256(Path(p).read_bytes()).hexdigest()} for p in paths]}
                return {"requests":requests,"files":paths,"evidence":evidence}
            finally:
                ctx.close()


class JushuitanAdapter(MerchantAdapter): pass
class PinduoduoAdapter(MerchantAdapter): pass
class TaobaoAdapter(MerchantAdapter):
    """Never approve applications or upload invoice results as part of collection."""
    def collect(self, connect_only=False):
        recipe = self.binding.get("recipe") or {}
        if not connect_only and recipe.get("pending_marker") not in ("待开票", "未开票", "待录入开票"):
            raise CollectionError("needs_verification","淘宝需验收明确的待开票列表，不能采集全部申请或自动同意待审核申请")
        return super().collect(connect_only)
class JDAdapter(MerchantAdapter): pass

ADAPTERS = {"jushuitan":JushuitanAdapter,"pinduoduo":PinduoduoAdapter,"taobao":TaobaoAdapter,"jd":JDAdapter}


def worker(job_path):
    job = json.loads(Path(job_path).read_text(encoding="utf-8"))
    for account in job["accounts"]:
        folder = Path(job["folder"]) / account["id"]
        try:
            result = ADAPTERS[account["platform"]](account,folder).collect(job.get("connect_only",False))
            if result is not None:
                dest = folder / "采集结果.json"
                dest.write_text(json.dumps(result,ensure_ascii=False),encoding="utf-8")
                event("collected",account_id=account["id"],path=str(dest))
        except CollectionError as e:
            event("account_failed",account_id=account["id"],state=e.state,message=str(e))
        except Exception:
            event("account_failed",account_id=account["id"],state="failed",message="页面访问或导出异常，请查看后台网络与权限后重试；未认定为零申请")
    event("finished")
