import json
import unittest
from pathlib import Path
from tests import test_v2 as fixtures
from invoice_assistant.execution import ExecutionQueue
from invoice_assistant.domain import identity
from invoice_assistant.archive import attach


class ExecutionTests(unittest.TestCase):
    setUp=fixtures.V2Tests.setUp
    tearDown=fixtures.V2Tests.tearDown

    def prepare(self,behavior="success"):
        r=fixtures.request(mock_behavior=behavior)
        self.engine.ingest(self.bid,[r]);self.engine.prepare(self.bid,["xinfutong"])
        self.queue=ExecutionQueue(self.store)
        self.queue.enqueue_batch(self.bid)
        return r,self.queue.rows()[0]["id"]

    def test_mock_end_to_end_not_real_issued(self):
        self.prepare();self.assertTrue(self.queue.run_one())
        self.assertEqual(self.queue.rows()[0]["state"],"simulated")
        self.assertFalse(self.queue.run_one())
        self.assertFalse(self.store.rows("SELECT * FROM invoices WHERE state='issued'"))
        files=self.store.rows("SELECT * FROM archive_files")
        self.assertEqual(len(files),1);self.assertEqual(files[0]["simulated"],1)
        self.assertTrue(Path(files[0]["path"]).is_file())

    def test_duplicate_enqueue_never_resubmits(self):
        self.prepare();self.queue.run_one()
        self.assertEqual(self.queue.enqueue_batch(self.bid),0)
        self.assertEqual(self.queue.rows()[0]["attempts"],1)

    def test_lost_response_reconciles_without_resubmit(self):
        _,tid=self.prepare("timeout_after")
        self.queue.run_one()
        self.assertEqual(self.queue.rows()[0]["state"],"unknown")
        with self.assertRaises(ValueError):self.queue.resume(tid)
        with self.assertRaises(ValueError):self.queue.cancel(tid)
        self.assertFalse(self.queue.run_one())
        self.queue.reconcile(tid)
        self.assertEqual(self.queue.rows()[0]["state"],"simulated")
        self.assertEqual(self.queue.rows()[0]["attempts"],1)

    def test_timeout_before_requires_query_then_manual_resume(self):
        _,tid=self.prepare("timeout_before");self.queue.run_one()
        self.queue.reconcile(tid)
        self.assertEqual(self.queue.rows()[0]["state"],"not_submitted")
        self.assertFalse(self.queue.run_one())
        self.queue.resume(tid)
        self.assertEqual(self.queue.rows()[0]["state"],"queued")

    def test_interrupted_submission_is_unknown(self):
        _,tid=self.prepare()
        self.store.execute("UPDATE execution_tasks SET state='submitting' WHERE id=?",(tid,))
        self.queue.recover_interrupted()
        self.assertEqual(self.queue.rows()[0]["state"],"unknown")
        self.assertFalse(self.queue.run_one())

    def test_pause_resume_cancel(self):
        _,tid=self.prepare();self.queue.pause(tid)
        self.assertFalse(self.queue.run_one())
        self.queue.resume(tid);self.queue.cancel(tid)
        self.assertFalse(self.queue.run_one())

    def test_global_pause_does_not_claim(self):
        self.prepare();self.store.set("queue_paused",True)
        self.assertFalse(self.queue.run_one())
        self.assertEqual(self.queue.rows()[0]["attempts"],0)

    def test_human_takeover_no_direct_retry(self):
        _,tid=self.prepare("needs_login");self.queue.run_one()
        self.assertEqual(self.queue.rows()[0]["state"],"awaiting_human")
        with self.assertRaises(ValueError):self.queue.resume(tid)
        self.queue.reconcile(tid)
        self.assertEqual(self.queue.rows()[0]["state"],"not_submitted")

    def test_changed_revision_fails_before_submit(self):
        r,_=self.prepare();self.engine.correct(identity(r),{"title":"修改后抬头"})
        self.queue.run_one()
        self.assertEqual(self.queue.rows()[0]["state"],"failed_preflight")
        self.assertEqual(self.queue.rows()[0]["attempts"],0)

    def test_real_providers_locked_even_if_setting_enabled(self):
        self.prepare();self.queue.cancel(self.queue.rows()[0]["id"])
        self.queue.enqueue_batch(self.bid,"xinfutong")
        self.store.set("automatic_execution_enabled",True)
        self.queue.run_one()
        tasks=[t for t in self.queue.rows() if t["provider"]=="xinfutong"]
        self.assertEqual(tasks[0]["state"],"failed_preflight")
        self.assertEqual(tasks[0]["attempts"],0)

    def test_cross_provider_duplicate_blocked(self):
        self.prepare();self.queue.enqueue_batch(self.bid,"xinfutong")
        with self.assertRaisesRegex(ValueError,"正式通道"):
            self.queue.enqueue_batch(self.bid,"zhejiang")

    def test_archive_requires_real_result_and_preserves_original(self):
        self.prepare();iid=self.queue.rows()[0]["invoice_id"]
        path=Path(self.temp.name)/"票据.pdf";path.write_bytes(b"%PDF-1.7\nsynthetic-test")
        with self.assertRaises(ValueError):attach(self.store,iid,path)
        self.engine.register_results([{"单据号":iid,"发票号码":"TEST-ONLY-123"}])
        one=attach(self.store,iid,path);two=attach(self.store,iid,path)
        self.assertEqual(one,two)
        self.assertEqual(path.read_bytes(),Path(one).read_bytes())
        self.assertEqual(len(self.store.rows("SELECT * FROM archive_files")),1)

    def test_split_simulation_keeps_real_parts_unissued(self):
        r=fixtures.request()
        r["items"]=r["items"]*2;r["amount"]="202.00"
        self.store.set("max_lines",1)
        self.engine.ingest(self.bid,[r]);self.engine.prepare(self.bid,["xinfutong"])
        q=ExecutionQueue(self.store);self.assertEqual(q.enqueue_batch(self.bid),2)
        while q.run_one():pass
        self.assertEqual([t["state"] for t in q.rows()],["simulated","simulated"])
        self.assertFalse(self.store.rows("SELECT * FROM invoices WHERE state='issued'"))

    def test_invalid_amount_never_enqueued(self):
        self.engine.ingest(self.bid,[fixtures.request(amount="999")]);self.engine.prepare(self.bid,["xinfutong"])
        self.assertEqual(ExecutionQueue(self.store).enqueue_batch(self.bid),0)

    def test_legacy_issued_guard_survives_correction_and_revalidation(self):
        r=fixtures.request()
        self.store.execute("INSERT INTO legacy_issued VALUES(?,?,?)",("order1","OLD-TEST-INVOICE","synthetic"))
        self.engine.ingest(self.bid,[r])
        self.engine.correct(identity(r),{"title":"资料修正"})
        self.engine.revalidate()
        summary=self.engine.prepare(self.bid,["xinfutong"])
        self.assertEqual(summary["files"],[])
        self.assertIn("legacy_issued",{p["code"] for p in self.engine.requests(self.bid)[0]["problems"]})

    def test_batch_review_tied_to_exact_revision(self):
        from invoice_assistant.store import fingerprint
        r,_=self.prepare()
        self.assertEqual(self.engine.approve_batch(self.bid),1)
        review=self.store.rows("SELECT * FROM request_reviews")[0]
        self.engine.correct(identity(r),{"title":"重新修改"})
        current=self.engine.requests(self.bid)[0]
        self.assertNotEqual(review["revision"],current["revision"])
        self.assertNotEqual(review["payload_hash"],fingerprint(current["payload"]))

    def test_real_worker_process_runs_mock_queue(self):
        import os
        import subprocess
        import sys
        self.prepare()
        job=Path(self.temp.name)/"worker-job.json"
        job.write_text(json.dumps({"data_dir":self.temp.name}),encoding="utf-8")
        result=subprocess.run([sys.executable,str(fixtures.ROOT/"assistant.py"),"--execution-worker",str(job)],
            capture_output=True,text=True,encoding="utf-8",env={**os.environ,"PYTHONUTF8":"1"},timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)["processed"],1)
        self.assertEqual(self.queue.rows()[0]["state"],"simulated")


if __name__=="__main__":unittest.main()
