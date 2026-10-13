"""Execution boundaries. No undocumented endpoint or automatic financial submission."""
from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
from pathlib import Path
from .store import dump, now
from .templates import render


@dataclass(frozen=True)
class ProviderResult:
    state: str  # succeeded / not_submitted / unknown / awaiting_human
    invoice_no: str = ""
    message: str = ""
    simulated: bool = False


class InvoiceProvider(ABC):
    name = ""
    simulated = False
    submit_verified = False

    @abstractmethod
    def prepare(self, task): ...

    @abstractmethod
    def submit(self, task): ...

    @abstractmethod
    def reconcile(self, task): ...


class TemplateProvider(InvoiceProvider):
    def __init__(self, store): self.store=store

    def prepare(self, task):
        path=self.store.root/"output"/"执行准备"/task["id"]/f"{self.name}.xlsx"
        render(self.store,self.name,[{"id":task["invoice_id"],"payload":task["payload"]}],path,self.store.get("seller",{}))
        return str(path)

    def submit(self, task):
        raise PermissionError("正式提交未通过真实授权、界面及接口验收；当前仅支持准备官方导入文件")

    def reconcile(self, task):
        return ProviderResult("awaiting_human",message="请在开票系统核对原单据及发票号码，不得直接重提")


class XinFuTongProvider(TemplateProvider):
    name="xinfutong"


class TaxPortalProvider(TemplateProvider):
    name="zhejiang"


class MockProvider(InvoiceProvider):
    """Persistent local fake service: can emulate success followed by a lost response."""
    name="mock"
    simulated=True
    submit_verified=True

    def __init__(self, store): self.store=store

    def prepare(self, task): return "模拟校验通过；不会联网或实际开票"

    def submit(self, task):
        previous=self.reconcile(task)
        if previous.state=="succeeded": return previous
        behavior=task["payload"].get("mock_behavior","success")
        if behavior=="needs_login":
            return ProviderResult("awaiting_human",message="模拟：需要人工登录",simulated=True)
        if behavior=="timeout_before": raise TimeoutError("模拟：提交连接中断")
        number="MOCK-"+task["idempotency_key"][:20]
        result=ProviderResult("succeeded",number,"模拟成功，非真实发票",True)
        self.store.execute("INSERT OR IGNORE INTO provider_receipts VALUES(?,?,?,?,?)",
            (task["idempotency_key"],self.name,number,dump(result.__dict__),now()))
        if behavior=="timeout_after": raise TimeoutError("模拟：已处理但响应丢失")
        return result

    def reconcile(self, task):
        rows=self.store.rows("SELECT result FROM provider_receipts WHERE idempotency_key=? AND provider='mock'",(task["idempotency_key"],))
        if rows:return ProviderResult(**json.loads(rows[0]["result"]))
        return ProviderResult("not_submitted",message="模拟服务已核实无提交记录",simulated=True)


def providers(store):
    return {p.name:p(store) for p in (MockProvider,XinFuTongProvider,TaxPortalProvider)}
