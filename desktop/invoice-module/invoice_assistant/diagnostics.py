from pathlib import Path
import importlib.metadata
import tempfile


def check():
    result = {"libraries":{},"edge_launch":False,"chrome_launch":False,"download":False,"browsers":{},"notes":[]}
    for lib in ("PySide6","playwright","openpyxl","xlrd","Nuitka"):
        try:
            result["libraries"][lib] = importlib.metadata.version(lib)
        except importlib.metadata.PackageNotFoundError:
            result["libraries"][lib] = "missing"
    try:
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory(prefix="invoice-browser-check-") as folder, sync_playwright() as p:
            for name,channel in (("chrome","chrome"),("edge","msedge")):
                browser=None
                result["browsers"][name]={"launch":False,"download":False}
                try:
                    browser = p.chromium.launch(channel=channel,headless=True)
                    result[name+"_launch"] = True
                    result["browsers"][name]["launch"] = True
                    page = browser.new_page(accept_downloads=True)
                    page.set_content('<a download="probe.txt" href="data:text/plain,invoice-assistant-test">download</a>')
                    with page.expect_download(timeout=10000) as d:
                        page.locator("a").click()
                    dest = Path(folder)/(name+"_probe.txt")
                    d.value.save_as(dest)
                    result["browsers"][name]["download"] = dest.read_text()=="invoice-assistant-test"
                except Exception as e:
                    result["notes"].append(type(e).__name__+": "+name+" 启动或本地受控下载失败")
                finally:
                    if browser:browser.close()
            result["download"] = result["browsers"].get("chrome",{}).get("download",False)
    except Exception as e:
        result["notes"].append(type(e).__name__+": Edge 启动或受控下载失败")
    result["notes"].append("本地下载测试不代表真实后台采集或税务系统导入验收")
    return result
