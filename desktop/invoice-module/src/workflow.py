"""导出前检查，以及每次运行的操作报告。"""
import html
import json
import math
import os
import re
from pathlib import Path


def assess(rows, cfg, files, summaries):
    global_issues = []
    if not str(cfg["seller"].get("name") or "").strip():
        global_issues.append("在 config.yaml 填写与新福通一致的销售方法人名称")
    if any("样例" in os.path.basename(f) for f in files):
        global_issues.append("输入含样例文件：正式处理前移走样例，防止混入测试订单")
    if any(s.get("error") for s in summaries):
        global_issues.append("存在读取失败的文件：修复文件后重新处理，避免不完整数据被导出")
    bad_orders = set()
    problems = []
    for row in rows:
        reasons = [s for s in str(row.get("异常标记") or "").split("；") if s]
        on = str(row.get("平台订单号") or row.get("ERP订单号") or "")
        if not on:
            reasons.append("缺订单号")
        if re.search(r"[eE][+-]?\d+$", on):
            reasons.append("订单号为科学计数法，请从平台重新导出文本订单号")
        if not row.get("店铺"):
            reasons.append("缺店铺：在订单或开票申请文件补充店铺名称")
        code = str(row.get("税收分类编码") or "")
        if code and not re.fullmatch(r"\d{19}", code):
            reasons.append("税收分类编码应填写开票系统中的19位完整编码")
        for key in ("数量", "价税合计"):
            value = float(row.get(key) or 0)
            if not math.isfinite(value) or value <= 0:
                reasons.append(f"{key}必须大于0，退款/红字业务另行处理")
        rate = float(row.get("税率") or 0)
        if not math.isfinite(rate) or not 0 <= rate <= 1:
            reasons.append("税率无效")
        # 对同一订单整单拦截，避免只开其中一条明细后整单被标记已开。
        if reasons:
            bad_orders.add(on)
        row["异常标记"] = "；".join(dict.fromkeys(reasons))
    ready, blocked = [], []
    for row in rows:
        on = str(row.get("平台订单号") or row.get("ERP订单号") or "")
        reasons = str(row.get("异常标记") or "")
        if global_issues or on in bad_orders:
            if global_issues:
                reasons = "；".join(global_issues + ([reasons] if reasons else []))
            else:
                reasons = reasons or "同订单其他明细存在异常"
            blocked.append(row)
            problems.append({"订单号": on, "商品": row.get("商品名称", ""), "原因": reasons})
        else:
            ready.append(row)
    return ready, blocked, global_issues, problems


def write_report(path, rows, ready, blocked, global_issues, problems, orphans, summaries, outs, errors):
    report = {
        "状态": "生成失败" if errors else "待修正" if blocked or orphans or global_issues else "可核对导入",
        "明细行数": len(rows), "可导出行数": len(ready), "待修正行数": len(blocked),
        "漏开票申请数": len(orphans), "全局检查": global_issues, "明细问题": problems,
        "文件读取": summaries, "生成失败": errors, "本次文件": dict(outs),
        "下一步": ["查看待开票台账与异常；编码在税收编码映射表补充，金额在源订单/申请核实修正",
                  "缺抬头税号：填写本次待补录清单后，在窗口点击补录回写，再重新处理",
                  "仅导入本次检查通过的新福通申请单；旧 output 文件不会被自动删除",
                  "实际开票成功后，准备含平台订单号、发票号码的结果表，点击登记已开票",
                  "生成导入表不代表已经开票，导入兼容性需要在实际开票系统核对"]}
    p = Path(path)
    p.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    esc = lambda v: html.escape(str(v))
    items = "".join(f"<li>{esc(x)}</li>" for x in report["下一步"])
    checks = "".join(f"<li>{esc(x)}</li>" for x in global_issues + errors)
    details = "".join(f"<tr><td>{esc(x['订单号'])}</td><td>{esc(x['商品'])}</td><td>{esc(x['原因'])}</td></tr>" for x in problems)
    links = "".join(f'<li><a href="{esc(Path(v).resolve().as_uri())}">{esc(k)} · {esc(Path(v).name)}</a></li>' for k, v in outs.items())
    p.write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本次开票处理报告</title>
<style>body{{font:16px/1.7 "Microsoft YaHei",sans-serif;max-width:1100px;margin:32px auto;padding:0 24px;color:#253447}}h1{{color:#184976}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ccd6df;padding:8px;text-align:left}}th{{background:#eef4f9}}a{{color:#1769aa}}</style>
<h1>本次开票处理：{esc(report['状态'])}</h1>
<p>待开票 {len(rows)} 行 · 通过 {len(ready)} 行 · 待修正 {len(blocked)} 行 · 漏单申请 {len(orphans)} 条</p>
<ul>{checks}</ul><h2>本次生成文件</h2><ul>{links}</ul>
<h2>操作流程</h2><ol>{items}</ol><h2>需要修正的订单</h2>
<table><tr><th>订单号</th><th>商品</th><th>处理原因</th></tr>{details}</table>
<p>仅使用本报告列出的本次文件。每次生成文件、实际开票、已开票登记是三个独立步骤。</p></html>''', encoding="utf-8")
    return report
