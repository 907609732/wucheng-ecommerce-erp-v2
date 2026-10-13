"""Platform status is evidence, not a guess from an invoice application record."""
VERSION = "platform-only-20261010"
PENDING = {
    "pinduoduo": {"待开票", "未开票"},
    "taobao": {"待开票", "未开票", "待录入开票"},
    "jd": {"待开票", "未开票"},
}
FINISHED = {"已开票", "开票成功", "已完成", "已取消", "已拒绝", "已关闭", "已作废", "已冲红"}


def eligibility_issues(req):
    issues = []
    def add(code, message):
        issues.append({"code": code, "message": message, "item": None})
    platform = req.get("platform")
    status = str(req.get("status") or "").strip()
    if platform == "jushuitan" or req.get("source_system") == "jushuitan":
        add("source_eligibility", "聚水潭申请记录不能证明当前未开票；请从电商后台重新获取待开票数据")
    elif status != "pending" and status not in PENDING.get(platform, set()):
        add("status", "后台状态不是明确待开票状态（空白、待审核、待处理均不自动开票）")
    if req.get("source_invoice_no"):
        add("source_issued", "原始记录已有发票号码，请核对原票；不能重复准备开票")
    if req.get("refund_status"):
        add("refund", "原始订单存在退款/售后标记，请核对实际开票金额，不自动扣减或开红票")
    if platform == "taobao" and status == "待录入开票" and req.get("external_invoice_checked") is not True:
        add("external_invoice_check", "淘宝待录入不等于未开票：请逐份核对新福通/税务局及线下开票记录，确认没有已开未回传的发票")
    return issues
