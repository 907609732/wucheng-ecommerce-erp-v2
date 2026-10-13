"""Explicit, isolated demonstration. Never imported as production pending work."""
from .engine import Engine
from .execution import ExecutionQueue


def create_demo(store):
    if store.rows("SELECT id FROM requests"):
        raise ValueError("演示仅允许使用空数据目录，禁止向现有真实库添加模拟申请")
    store.set("seller",{"name":"模拟销售方（非真实企业）"})
    store.set("seller_confirmed",True)
    store.set("default_rate","0.01")
    store.set("demo_mode",True)
    bid=store.batch("mock_demo",{"targets":["xinfutong"],"scope":"隔离模拟数据，非真实后台采集"})
    req={"account_id":"mock","platform":"taobao","company":"模拟公司","shop_id":"MOCK-SHOP","shop":"模拟店铺",
      "source_id":"MOCK-APPLICATION","applied_at":"2026-10-10","order_nos":["MOCK-ORDER"],"title":"模拟个人买家",
      "tax_no":"","personal":True,"invoice_type":"普通","amount":"10.10","status":"待开票","tax_included":True,"collection_complete":True,
      "items":[{"order_no":"MOCK-ORDER","sku":"MOCK-SKU","name":"模拟商品","spec":"测试规格","unit":"件","qty":"1","amount":"10.10","tax_code":"1090511030000000000","rate":"0.01"}]}
    core=Engine(store);core.ingest(bid,[req]);core.prepare(bid,["xinfutong"])
    queue=ExecutionQueue(store);queue.enqueue_batch(bid,"mock")
    while queue.run_one():pass
    return bid
