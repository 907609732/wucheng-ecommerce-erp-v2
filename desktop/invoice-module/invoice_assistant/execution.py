"""Durable, conservative task state machine. Unknown never means retryable."""
import hashlib
import json
from pathlib import Path
from .domain import validate
from .engine import Engine
from .providers import providers
from .store import Store, dump, fingerprint, now, uid

LABELS={"queued":"待执行","paused":"已暂停","submitting":"提交中","unknown":"结果未知，禁止重提",
 "reconciling":"核对中","awaiting_human":"等待人工接管","not_submitted":"已核实未提交，可恢复",
 "failed_preflight":"前置检查未通过","cancelled":"已取消","succeeded":"已核实开票成功",
 "simulated":"模拟成功（非真实开票）","special_hold":"退款/红冲/拆单需专门处理"}


class ExecutionQueue:
    def __init__(self,store,registry=None):
        self.store=store
        self.providers=registry if registry is not None else providers(store)

    def rows(self):
        rows=self.store.rows("SELECT * FROM execution_tasks ORDER BY created,id")
        for row in rows:
            row["payload"]=json.loads(row["payload"])
            row["label"]=LABELS.get(row["state"],row["state"])
        return rows

    @staticmethod
    def record(conn,tid,before,after,message):
        conn.execute("INSERT INTO execution_events VALUES(?,?,?,?,?,?)",(uid(),tid,now(),before,after,message))

    def enqueue_batch(self,bid,provider="mock"):
        if provider not in self.providers:raise ValueError("未知开票适配器")
        core=Engine(self.store);core.revalidate()
        count=0
        with self.store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows=conn.execute("SELECT i.*,r.state AS request_state,r.revision AS current_revision FROM invoices i JOIN requests r ON r.id=i.request_id JOIN batch_requests b ON b.request_id=r.id WHERE b.batch_id=?",(bid,)).fetchall()
            for row in rows:
                if row["state"]=="issued" or row["request_state"] not in ("ready","prepared","partially_issued") or row["revision"]!=row["current_revision"]:continue
                old=conn.execute("SELECT * FROM execution_tasks WHERE invoice_id=?",(row["id"],)).fetchall()
                if any(t["provider"]==provider for t in old):continue
                if provider!="mock" and any(t["provider"]!="mock" and t["state"]!="cancelled" for t in old):
                    raise ValueError("该单据已有正式通道任务，不能切换通道重复提交")
                tid=uid();key=fingerprint([provider,row["id"],row["revision"]])
                conn.execute("INSERT INTO execution_tasks(id,invoice_id,provider,state,payload,payload_hash,idempotency_key,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
                    (tid,row["id"],provider,"queued",row["payload"],fingerprint(json.loads(row["payload"])),key,now(),now()))
                self.record(conn,tid,"","queued","从通过校验的当前版本单据建立任务" if provider!="mock" else "建立模拟任务，不改变真实开票记录")
                count+=1
        return count

    def transition(self,tid,expected,state,message):
        with self.store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row=conn.execute("SELECT state FROM execution_tasks WHERE id=?",(tid,)).fetchone()
            if not row or row["state"] not in expected:raise ValueError("任务状态已变化或不允许此操作")
            conn.execute("UPDATE execution_tasks SET state=?,message=?,updated=? WHERE id=?",(state,message,now(),tid))
            self.record(conn,tid,row["state"],state,message)

    def pause(self,tid):self.transition(tid,{"queued"},"paused","人工暂停，尚未提交")
    def resume(self,tid):self.transition(tid,{"paused","not_submitted"},"queued","人工恢复；已确认可安全执行")
    def cancel(self,tid):self.transition(tid,{"queued","paused","not_submitted","failed_preflight"},"cancelled","人工取消，未提交")

    def recover_interrupted(self):
        for task in self.rows():
            if task["state"] in ("submitting","reconciling"):
                self.transition(task["id"],{task["state"]},"unknown","进程中断，须核对原系统，禁止直接重试")

    def preflight(self,task):
        core=Engine(self.store)
        rows=self.store.rows("SELECT i.*,r.state AS request_state,r.revision AS current_revision,r.payload AS request_payload FROM invoices i JOIN requests r ON r.id=i.request_id WHERE i.id=?",(task["invoice_id"],))
        if not rows:raise ValueError("原开票单据不存在")
        row=rows[0]
        if row["state"]=="issued" or row["request_state"] not in ("ready","prepared","partially_issued"):
            raise ValueError("申请已开票或未通过校验")
        if row["revision"]!=row["current_revision"] or fingerprint(json.loads(row["payload"]))!=task["payload_hash"]:
            raise ValueError("申请版本发生变化，请重新审核，旧任务不得提交")
        if fingerprint(task["payload"])!=task["payload_hash"]:raise ValueError("任务快照损坏")
        if not self.store.get("seller_confirmed",False):raise ValueError("销售方及税率尚未确认")
        _,issues=validate(json.loads(row["request_payload"]),core.maps(),core.settings())
        if issues:raise ValueError("提交前校验未通过，请返回申请补资料")
        provider=self.providers[task["provider"]]
        if not provider.simulated:
            review=self.store.rows("SELECT * FROM request_reviews WHERE request_id=?",(row["request_id"],))
            if not review or review[0]["revision"]!=row["current_revision"] or review[0]["payload_hash"]!=fingerprint(json.loads(row["request_payload"])):
                raise PermissionError("当前版本尚未人工审核通过")
            if not self.store.get("automatic_execution_enabled",False):raise PermissionError("正式自动执行模式未启用")
            if not provider.submit_verified:raise PermissionError("此通道正式提交未验收，不能启用")
        provider.prepare(task)

    def run_one(self):
        self.store.execute("INSERT OR IGNORE INTO settings VALUES('queue_paused','false')")
        if self.store.get("queue_paused",False):return False
        # Claim before preflight, so a concurrent worker cannot submit the same task.
        with self.store.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row=conn.execute("SELECT * FROM execution_tasks WHERE state='queued' ORDER BY created,id LIMIT 1").fetchone()
            if not row:return False
            task=dict(row);task["payload"]=json.loads(task["payload"])
            conn.execute("UPDATE execution_tasks SET state='submitting',updated=? WHERE id=?",(now(),task["id"]))
            self.record(conn,task["id"],"queued","submitting","独占领取任务，开始前置检查")
        try:self.preflight(task)
        except Exception:
            self.transition(task["id"],{"submitting"},"failed_preflight","前置检查或通道授权未通过，未调用提交；请核对资料与验收状态")
            return True
        self.store.execute("UPDATE execution_tasks SET attempts=attempts+1 WHERE id=?",(task["id"],))
        try:result=self.providers[task["provider"]].submit(task)
        except Exception:
            self.transition(task["id"],{"submitting"},"unknown","提交调用未返回确定结果，禁止重试，必须先核对原系统")
            return True
        self.finish_result(task,result,{"submitting"})
        return True

    def finish_result(self,task,result,expected):
        provider=self.providers[task["provider"]]
        if result.state=="succeeded":
            if not result.invoice_no or bool(result.simulated)!=bool(provider.simulated):
                self.transition(task["id"],expected,"unknown","返回缺少号码或模拟/正式身份不符，须核实")
                return
            if provider.simulated:
                if not result.invoice_no.startswith("MOCK-"):
                    self.transition(task["id"],expected,"unknown","模拟号码格式不符")
                    return
                self.archive_receipt(task,result)
                self.transition(task["id"],expected,"simulated","模拟成功；未登记真实发票")
            else:
                try:Engine(self.store).register_results([{"单据号":task["invoice_id"],"发票号码":result.invoice_no}])
                except Exception:
                    self.transition(task["id"],expected,"unknown","返回成功但本地登记冲突，请核对原票，禁止重提")
                    return
                self.transition(task["id"],expected,"succeeded","原系统已返回成功，发票号码已登记")
        elif result.state=="not_submitted":self.transition(task["id"],expected,"not_submitted","已通过原通道查询确认未提交；需人工恢复，不自动重提")
        elif result.state=="awaiting_human":self.transition(task["id"],expected,"awaiting_human","需要人工接管或在原系统核对；不自动重提")
        else:self.transition(task["id"],expected,"unknown","结果尚未核实，禁止重提")

    def reconcile(self,tid):
        task=next((t for t in self.rows() if t["id"]==tid),None)
        if not task:raise ValueError("任务不存在")
        self.transition(tid,{"unknown","awaiting_human"},"reconciling","仅查询原提交结果，不调用提交")
        try:result=self.providers[task["provider"]].reconcile(task)
        except Exception:
            self.transition(tid,{"reconciling"},"unknown","查询失败，保留未知状态，禁止重提")
            return
        self.finish_result(task,result,{"reconciling"})

    def archive_receipt(self,task,result):
        data=dump({"task_id":task["id"],"invoice_id":task["invoice_id"],"result":result.__dict__,"note":"模拟凭证，不是发票"}).encode("utf-8")
        sha=hashlib.sha256(data).hexdigest()
        path=self.store.root/"归档"/"模拟凭证"/(sha+".json")
        path.parent.mkdir(parents=True,exist_ok=True)
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()!=sha:raise ValueError("归档指纹不符")
        if not path.exists():path.write_bytes(data)
        self.store.execute("INSERT OR IGNORE INTO archive_files VALUES(?,?,?,?,?,?,?,?)",(uid(),task["invoice_id"],sha,str(path),path.name,"mock_receipt",1,now()))


def worker(job_path):
    job=json.loads(Path(job_path).read_text(encoding="utf-8"))
    queue=ExecutionQueue(Store(job["data_dir"]))
    count=0
    while queue.run_one():count+=1
    print(dump({"processed":count,"message":"队列执行结束；模拟任务不代表实际开票"}),flush=True)
