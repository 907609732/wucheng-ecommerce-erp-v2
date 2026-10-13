from __future__ import annotations
import json
import os
import sys
from pathlib import Path

from PySide6.QtCore import QObject, Signal, Property, Slot, QProcess, QUrl
from PySide6.QtGui import QDesktopServices

from .store import dump, uid, now
from .engine import Engine, parse_recovery_files
from .templates import register
from .migration import read_table
from .collector import PLATFORMS
from .execution import ExecutionQueue

STATES = {"queued":"等待开始","running":"采集中","needs_login":"需要登录","needs_binding":"需要绑定店铺",
    "needs_verification":"采集路径待验收","failed":"采集失败","incomplete":"采集不完整","complete":"采集完成",
    "prepared":"文件已生成","partial":"部分完成","empty":"范围内无待开票申请","needs_template":"需要官方模板",
    "cancelled":"已取消，可重试","interrupted":"上次中断，可恢复","ready":"检查通过","needs_review":"需要处理",
    "issued":"已登记开票成功","partially_issued":"部分开票成功"}


class Controller(QObject):
    changed = Signal()

    def __init__(self,store,base):
        super().__init__()
        self.store,self.base,self.core = store,Path(base),Engine(store)
        self.proc = None
        self.execution_proc = None
        self.queue = ExecutionQueue(store)
        self.mapping_preview={"headers":[],"account_id":"","role":"request","fields":[]}
        self.queue.recover_interrupted()
        self.buffer = ""
        self.current = ""
        self.message = "选择数据来源，助手将整理待开票申请并准备导入文件。"
        self.stage = "尚未开始"
        self.connect_only = False
        from .eligibility import VERSION
        if self.store.get("eligibility_policy") != VERSION:
            self.core.revalidate()
            self.store.set("eligibility_policy", VERSION)
            self.store.audit("eligibility_policy", VERSION, None, {"jushuitan_enabled":False,"blank_is_pending":False})
        self.store.execute("UPDATE batches SET state='interrupted' WHERE state IN ('running','queued','needs_login')")
        latest = store.rows("SELECT id FROM batches ORDER BY created DESC LIMIT 1")
        if latest: self.current = latest[0]["id"]
        self.refresh()

    @Property('QVariantMap',notify=changed)
    def view(self): return self._view

    def refresh(self):
        accounts = self.store.rows("SELECT * FROM accounts ORDER BY platform,name")
        for a in accounts:
            a["label"] = PLATFORMS[a["platform"]]["name"]
            a["state_label"] = STATES.get(a["state"],a["state"])
        history = self.store.rows("SELECT * FROM batches ORDER BY created DESC")
        for h in history:
            h["summary"] = json.loads(h["summary"])
            h["summary"].update(self.core.summary(h["id"]))
            h["state_label"] = STATES.get(h["state"],h["state"])
            h["date"] = h["created"][:19].replace("T"," ")
        requests = self.core.requests(self.current) if self.current else []
        issues=[]
        for r in requests:
            for p in r["problems"]:
                item = r["payload"].get("items",[])[p["item"]] if p.get("item") is not None else {}
                issues.append({"rid":r["id"],"item":p.get("item",-1),"code":p["code"],"message":p["message"],
                    "title":r["payload"].get("title") or "未填写抬头","product":item.get("name", ""),"sku":item.get("sku",""),
                    "source":r["payload"].get("source_file", "后台采集"),"amount":r["payload"].get("amount", ""),"total":r["payload"].get("detail_total", ""),
                    "order":"，".join(r["payload"].get("order_nos",[])),"payload":r["payload"]})
        summary = self.core.summary(self.current) if self.current else {}
        batch = self.store.rows("SELECT * FROM batches WHERE id=?",(self.current,)) if self.current else []
        if batch:
            summary = {**json.loads(batch[0]["summary"]),**summary}
        files = self.store.rows("SELECT * FROM exports WHERE batch_id=? AND state='prepared'",(self.current,)) if self.current else []
        scope = self.store.rows("SELECT a.name,b.state,b.evidence FROM batch_accounts b JOIN accounts a ON a.id=b.account_id WHERE b.batch_id=?",(self.current,)) if self.current else []
        for s in scope:
            e=json.loads(s["evidence"])
            s["text"]=s["name"]+" · "+STATES.get(s["state"],s["state"])+" · "+e.get("scope",e.get("message","查询范围尚未确认"))
        self._view={"accounts":accounts,"history":history,"issues":issues,"summary":summary,"files":files,"scope":scope,
            "current":self.current,"batch_state":STATES.get(batch[0]["state"],batch[0]["state"]) if batch else "",
            "busy":self.proc is not None or self.execution_proc is not None,"message":self.message,"stage":self.stage,"seller":self.store.get("seller",{}),
            "execution_tasks":self.queue.rows(),"queue_paused":self.store.get("queue_paused",False),"demo_mode":self.store.get("demo_mode",False),
            "mapping_preview":self.mapping_preview,
            "rate":self.store.get("default_rate","0.01"),"seller_confirmed":self.store.get("seller_confirmed",False),
            "targets":self.store.get("targets",["xinfutong","zhejiang"]),"templates":self.store.rows("SELECT target,signature,verified FROM templates"),
            "data_dir":str(self.store.root)}
        self.changed.emit()

    def attempt(self,fn):
        try: fn()
        except Exception as e: self.message=str(e)
        self.refresh()

    @Slot()
    def approveBatch(self):
        def run():
            if not self.current or self.proc or self.execution_proc:raise ValueError("请选择已完成检查的批次")
            count=self.core.approve_batch(self.current)
            self.message=f"已记录 {count} 份合格申请的当前版本审核；异常未放行，正式自动提交仍锁定。"
        self.attempt(run)

    @Slot(str,str,str)
    def previewMapping(self,aid,path,role):
        self.mapping_preview={"headers":[],"account_id":"","role":"request","fields":[],"overrides":{}}
        def run():
            from src.readers import read_raw,find_header_row
            from src.requests import REQUEST_ALIASES
            from src.fieldmap import COMMON_ALIASES
            if role not in ("request","detail"):raise ValueError("未知文件角色")
            path=QUrl(path).toLocalFile() if path.startswith("file:") else path
            raw=read_raw(path)
            if not raw:raise ValueError("文件为空")
            headers=list(map(str,raw[find_header_row(raw)]))
            fields=list(REQUEST_ALIASES) if role=="request" else list(COMMON_ALIASES)
            if role=="request":fields += ["source_id","shop_id","source_invoice_no","refund_status"]
            aliases=REQUEST_ALIASES if role=="request" else COMMON_ALIASES
            extras={"source_id":"申请编号","shop_id":"店铺ID","source_invoice_no":"原发票号码","refund_status":"退款状态"}
            rows=self.store.rows("SELECT binding FROM accounts WHERE id=?",(aid,))
            if not rows:raise ValueError("账号不存在")
            existing=json.loads(rows[0]["binding"]).get("field_mapping",{}).get(role,{})
            self.mapping_preview={"headers":headers,"account_id":aid,"role":role,"overrides":existing,"fields":[{"key":key,"label":aliases[key][0] if key in aliases else extras[key]} for key in fields]}
            self.message="仅预览表头，没有导入申请。选择需要覆盖的列，其他字段继续自动识别。"
        self.attempt(run)

    @Slot(str)
    def saveMapping(self,fields):
        def run():
            from .columns import column_map,normalized
            preview=self.mapping_preview
            if not preview["headers"]:raise ValueError("请先选择表格预览表头")
            values=json.loads(fields)
            column_map(preview["headers"],"",preview["role"]=="request",values)
            rows=self.store.rows("SELECT binding FROM accounts WHERE id=?",(preview["account_id"],))
            if not rows:raise ValueError("账号不存在")
            before=json.loads(rows[0]["binding"]);binding={**before}
            binding["field_mapping"]={**before.get("field_mapping",{}),preview["role"]:values}
            binding["field_mapping_headers"]={**before.get("field_mapping_headers",{}),preview["role"]:[normalized(h) for h in preview["headers"]]}
            self.store.execute("UPDATE accounts SET binding=?,updated=? WHERE id=?",(dump(binding),now(),preview["account_id"]))
            self.store.audit("field_mapping",preview["account_id"],before.get("field_mapping",{}),binding["field_mapping"])
            self.message="映射已保存到本店铺；重新采集/恢复时使用，不自动改写历史申请。"
        self.attempt(run)

    @Slot()
    def enqueueMock(self):
        def run():
            if self.proc or self.execution_proc:raise ValueError("请先结束当前任务")
            if not self.current:raise ValueError("请先选择已检查并生成文件的批次")
            count=self.queue.enqueue_batch(self.current,"mock")
            self.message=f"建立 {count} 条模拟任务；不会实际开票、回写平台或登记真实发票号码。"
        self.attempt(run)

    @Slot()
    def runMockQueue(self):
        def run():
            if self.proc or self.execution_proc:raise ValueError("已有任务正在运行")
            # GUI only enables the mock provider; no production execution toggle is exposed.
            if any(t["provider"]!="mock" and t["state"]=="queued" for t in self.queue.rows()):raise ValueError("存在正式通道任务，当前界面仅允许模拟执行")
            if self.store.get("queue_paused",False):raise ValueError("请先恢复队列")
            job=self.store.root/"执行任务.json"
            job.write_text(dump({"data_dir":str(self.store.root)}),encoding="utf-8")
            self.execution_proc=QProcess(self)
            self.execution_proc.setWorkingDirectory(str(self.base))
            self.execution_proc.finished.connect(self.executionFinished)
            self.execution_proc.errorOccurred.connect(lambda _:self.executionError())
            args=["--execution-worker",str(job)]
            if not getattr(sys,"frozen",False) and "__compiled__" not in globals():args=[str(self.base/"assistant.py"),*args]
            self.execution_proc.start(sys.executable,args)
            self.message="正在独立进程运行模拟队列；不会实际开具发票。"
        self.attempt(run)

    def executionFinished(self,*args):
        if self.execution_proc:
            process=self.execution_proc;self.execution_proc=None;process.deleteLater()
        self.queue.recover_interrupted()
        self.message="队列执行结束。未知结果须先核对，模拟成功不代表真实开票。"
        self.refresh()

    def executionError(self):
        if self.execution_proc and self.execution_proc.state()==QProcess.NotRunning:self.executionFinished()

    @Slot()
    def toggleQueue(self):
        paused=not self.store.get("queue_paused",False)
        self.store.set("queue_paused",paused)
        self.store.audit("queue_pause","queue",not paused,paused)
        self.message="队列已暂停；已开始的调用会完成并核对结果，不会强行视为取消。" if paused else "队列已恢复，可点击运行模拟队列。"
        self.refresh()

    @Slot(str,str)
    def taskAction(self,tid,action):
        def run():
            if self.execution_proc:raise ValueError("请等待当前执行进程结束")
            if action not in ("pause","resume","cancel","reconcile"):raise ValueError("不支持此操作")
            getattr(self.queue,action)(tid)
            self.message="任务状态已更新并记录执行事件。"
        self.attempt(run)

    @Slot(str,str,str,str,str,str)
    def addAccount(self,platform,name,company,shopid,identity,recipe):
        def run():
            if platform not in PLATFORMS or not name.strip(): raise ValueError("请选择平台并填写账号显示名称")
            binding={"identity_text":identity.strip()}
            if recipe.strip(): binding["recipe"]=json.loads(recipe)
            aid=uid()
            self.store.execute("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)",(aid,platform,name.strip(),company.strip(),shopid.strip(),"needs_login",dump(binding),now()))
            self.message="店铺已添加。点击连接，在专用浏览器完成登录；真实后台路径仍需验收。"
        self.attempt(run)

    @Slot(str)
    def loginPlatform(self,platform):
        def run():
            if self.proc or self.execution_proc:raise ValueError("请先完成或取消当前任务")
            if platform not in ("taobao","pinduoduo","jd"):raise ValueError("请选择支持的电商平台")
            drafts=self.store.rows("SELECT * FROM accounts WHERE platform=? AND shop_id='' ORDER BY updated DESC",(platform,))
            if drafts:
                account=drafts[0]
            else:
                aid=uid()
                self.store.execute("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)",
                                   (aid,platform,PLATFORMS[platform]["name"]+" · 登录后自动识别","","","needs_login","{}",now()))
                account=self.store.rows("SELECT * FROM accounts WHERE id=?",(aid,))[0]
            self.launch([account],True)
        self.attempt(run)

    @Slot(str,str,str,str,str)
    def updateBinding(self,aid,identity,recipe,company,shopid):
        def run():
            old=self.store.rows("SELECT binding FROM accounts WHERE id=?",(aid,))
            binding={**json.loads(old[0]["binding"]),"identity_text":identity.strip()}
            binding["recipe"]=json.loads(recipe) if recipe.strip() else {}
            if not company.strip() or not shopid.strip():raise ValueError("请填写真实公司名称及店铺/公司ID，防止跨店串单")
            self.store.execute("UPDATE accounts SET binding=?,company=?,shop_id=?,state='needs_login',updated=? WHERE id=?",(dump(binding),company.strip(),shopid.strip(),now(),aid))
            self.store.audit("binding",aid,json.loads(old[0]["binding"]),binding)
            self.message="绑定资料已保存。请重新连接确认店铺身份。"
        self.attempt(run)

    @Slot(str,str,str)
    def saveSeller(self,name,taxno,rate):
        def run():
            from .domain import decimal
            if not name.strip() or not 0<=decimal(rate)<=1: raise ValueError("销售方名称和税率无效")
            before=self.store.get("seller",{})
            self.store.set("seller",{**before,"name":name.strip(),"tax_no":taxno.strip()})
            self.store.set("default_rate",str(decimal(rate)))
            self.store.set("seller_confirmed",True)
            self.store.audit("seller","settings",before,self.store.get("seller"))
            self.core.revalidate()
            self.message="销售方资料已确认。税率请以适用政策和实际业务为准。"
        self.attempt(run)

    @Slot(str,'QVariantList','QVariantList')
    def start(self,mode,ids,targets):
        def run():
            if self.proc or self.execution_proc: raise ValueError("已有任务正在运行，请勿重复启动")
            if mode != "platform": raise ValueError("聚水潭模式已暂停：申请记录无法证明当前未开票，请使用电商平台模式")
            if not ids: raise ValueError("请先在资料设置连接账号，再选择需要采集的店铺")
            if not targets: raise ValueError("请至少选择一种输出格式")
            if not self.store.get("seller_confirmed",False): raise ValueError("首次使用请先在资料设置确认销售方与税率")
            accounts=[a for a in self.store.rows("SELECT * FROM accounts") if a["id"] in ids]
            if len(accounts)!=len(ids):raise ValueError("所选账号已变化，请重新选择")
            if any(not a["shop_id"] or not a["company"] for a in accounts):raise ValueError("请先绑定真实公司名称和店铺/公司ID")
            if any((a["platform"]=="jushuitan") != (mode=="jushuitan") for a in accounts): raise ValueError("所选店铺不属于当前模式")
            self.store.set("targets",targets)
            self.current=self.store.batch(mode,{"targets":targets},ids)
            self.launch(accounts)
        self.attempt(run)

    def launch(self,accounts,connect_only=False):
        self.connect_only=connect_only
        folder=self.store.root/"output"/"批次"/(self.current or "连接")
        folder.mkdir(parents=True,exist_ok=True)
        job=folder/("连接任务.json" if connect_only else "采集任务.json")
        job.write_text(dump({"accounts":accounts,"folder":str(folder/"原始导出"),"connect_only":connect_only}),encoding="utf-8")
        self.proc=QProcess(self)
        self.proc.setProcessChannelMode(QProcess.SeparateChannels)
        env=self.proc.processEnvironment()
        from PySide6.QtCore import QProcessEnvironment
        env=QProcessEnvironment.systemEnvironment();env.insert("PYTHONUTF8","1");env.insert("PYTHONIOENCODING","utf-8")
        self.proc.setProcessEnvironment(env)
        self.proc.readyReadStandardOutput.connect(self.read_events)
        self.proc.finished.connect(self.finish)
        self.proc.errorOccurred.connect(lambda _: self.process_error())
        self.buffer=""
        self.stage="连接后台";self.message="正在打开专用 Chrome 浏览器；首次登录需扫码，之后复用该店铺登录状态。"
        if not connect_only: self.store.update_batch(self.current,"running")
        self.proc.setWorkingDirectory(str(self.base))
        if getattr(sys,"frozen",False) or "__compiled__" in globals():
            self.proc.start(sys.executable,["--worker",str(job)])
        else: self.proc.start(sys.executable,["-u",str(self.base/"assistant.py"),"--worker",str(job)])

    @Slot(str)
    def connectAccount(self,aid):
        def run():
            if self.proc: raise ValueError("请先完成或取消当前浏览器任务")
            accounts=self.store.rows("SELECT * FROM accounts WHERE id=?",(aid,))
            if accounts and accounts[0]["platform"] == "jushuitan":raise ValueError("聚水潭采集已暂停，请添加电商平台店铺")
            if accounts: self.launch(accounts,True)
        self.attempt(run)

    def read_events(self):
        if not self.proc:return
        self.buffer+=bytes(self.proc.readAllStandardOutput()).decode("utf-8",errors="replace")
        while "\n" in self.buffer:
            line,self.buffer=self.buffer.split("\n",1)
            try: item=json.loads(line)
            except ValueError: continue
            kind=item.get("kind");aid=item.get("account_id")
            if kind=="stage": self.stage=item["stage"]
            if item.get("message"): self.message=item["message"]
            if kind=="connected":
                try:
                    from .shop_identity import bind_recognized
                    bind_recognized(self.store,aid,item.get("identity") or {})
                except ValueError as e:
                    self.message=str(e)
                    self.store.execute("UPDATE accounts SET state='needs_verification',updated=? WHERE id=?",(now(),aid))
                    # Do not continue any collection after a failed identity binding.
                    self.cancel()
                    self.message=str(e)
                    self.refresh()
                    return
            if kind in ("account_failed","needs_login"):
                state=item.get("state","needs_login")
                self.store.execute("UPDATE accounts SET state=?,updated=? WHERE id=?",(state,now(),aid))
                if not self.connect_only:
                    self.store.execute("UPDATE batch_accounts SET state=?,evidence=? WHERE batch_id=? AND account_id=?",(state,dump({"message":item.get("message","")}),self.current,aid))
            if kind=="collected":
                try:
                    result=json.loads(Path(item["path"]).read_text(encoding="utf-8"))
                    self.core.ingest(self.current,result["requests"])
                    self.store.execute("UPDATE batch_accounts SET state='complete',evidence=? WHERE batch_id=? AND account_id=?",(dump(result["evidence"]),self.current,aid))
                    self.store.execute("INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?)",(self.current,aid,"verified_export",dump({"path":item["path"],"evidence":result["evidence"]})))
                except Exception as e: self.message="采集结果校验失败："+str(e)
            self.refresh()

    def process_error(self):
        if self.proc and self.proc.state()==QProcess.NotRunning:
            self.message="采集子进程无法启动，请运行环境检查。"
            self.finish(-1,QProcess.CrashExit)

    def finish(self,code=0,status=None):
        if not self.proc:return
        self.read_events()
        process=self.proc;self.proc=None;process.deleteLater()
        if not self.connect_only:
            self.store.execute("UPDATE batch_accounts SET state='failed',evidence=? WHERE batch_id=? AND state='queued'",(dump({"message":"子进程中断或未返回完整性证明"}),self.current))
            self.stage="准备文件"
            try:
                opts=json.loads(self.store.rows("SELECT options FROM batches WHERE id=?",(self.current,))[0]["options"])
                self.core.prepare(self.current,opts["targets"])
                self.message="处理结束：请查看采集范围、待处理问题和文件状态。文件已生成不代表已开票。"
            except Exception as e: self.message=str(e);self.store.update_batch(self.current,"partial")
        self.refresh()

    @Slot()
    def continueBrowser(self):
        if self.proc:self.proc.write(b"continue\n")

    @Slot()
    def cancel(self):
        if self.proc:
            proc=self.proc;self.proc=None
            proc.kill();proc.waitForFinished(3000);proc.deleteLater()
            if not self.connect_only:
                self.store.update_batch(self.current,"cancelled")
                self.store.execute("UPDATE batch_accounts SET state='cancelled' WHERE batch_id=? AND state!='complete'",(self.current,))
            self.message="任务已取消，已核验的数据与批次仍然保留，可重试未完成店铺。"
            self.refresh()

    @Slot()
    def retry(self):
        def run():
            if self.proc:raise ValueError("任务正在运行")
            accounts=self.store.rows("SELECT a.* FROM accounts a JOIN batch_accounts b ON b.account_id=a.id WHERE b.batch_id=? AND b.state!='complete'",(self.current,))
            if any(a["platform"]=="jushuitan" for a in accounts):raise ValueError("旧聚水潭批次不能继续采集，请新建电商平台批次")
            if accounts:self.launch(accounts)
            else:self.generate()
        self.attempt(run)

    @Slot()
    def generate(self):
        def run():
            if not self.current:raise ValueError("尚无批次")
            opts=json.loads(self.store.rows("SELECT options FROM batches WHERE id=?",(self.current,))[0]["options"])
            self.core.prepare(self.current,opts["targets"])
            self.message="已重新检查并准备文件；请确认目标系统试导入结果。"
        self.attempt(run)

    @Slot(str)
    def selectBatch(self,bid):
        if self.proc:self.message="当前任务结束后才能切换批次"
        else:self.current=bid
        self.refresh()

    @Slot(str,int,str,str)
    def correct(self,rid,index,key,value):
        def run():
            self.core.correct(rid,{key:value},None if index<0 else index)
            self.message="资料已保存并重新检查；同SKU映射会复用于其他未开票申请。"
        self.attempt(run)

    @Slot(str)
    def confirmNotIssued(self,rid):
        def run():
            self.core.correct(rid,{"external_invoice_checked":True})
            self.message="已记录本份申请的外部开票核对确认；其他申请仍需分别核对。"
        self.attempt(run)

    @Slot(str)
    def openFile(self,path):
        allowed=self.store.root.resolve()
        try:
            resolved=Path(path).resolve()
            if not resolved.is_relative_to(allowed) or not resolved.exists():raise ValueError("文件不存在或不属于助手数据目录")
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(resolved)))
        except Exception as e:self.message=str(e);self.refresh()

    @Slot(str,str)
    def importTemplate(self,target,path):
        self.attempt(lambda:register(self.store,target,QUrl(path).toLocalFile() if path.startswith("file:") else path))

    @Slot(str,'QVariantList')
    def recover(self,aid,paths):
        def run():
            if self.proc:raise ValueError("请先结束当前采集任务")
            a=self.store.rows("SELECT * FROM accounts WHERE id=?",(aid,))
            if not a:raise ValueError("请选择来源账号")
            if a[0]["platform"] == "jushuitan":raise ValueError("聚水潭申请记录不再作为待开票来源，请选择电商平台账号")
            paths=[QUrl(p).toLocalFile() if p.startswith("file:") else p for p in paths]
            requests=parse_recovery_files(paths,a[0],True)
            if not requests:raise ValueError("未识别到有效开票申请，不能把销售明细作为申请")
            self.current=self.store.batch("recovery",{"targets":self.store.get("targets",["xinfutong","zhejiang"]),"scope":"人工恢复导入，非后台全量采集"})
            self.core.ingest(self.current,requests)
            self.store.update_batch(self.current,"partial",{"scope":"人工恢复导入，完整后台范围未验收"})
            self.message="恢复文件已读入；这不是后台全量采集证明。请补资料后生成。"
        self.attempt(run)

    @Slot(str)
    def importResults(self,path):
        def run():
            path=QUrl(path).toLocalFile() if path.startswith("file:") else path
            count=self.core.register_results(read_table(path))
            self.message=f"已按单据登记 {count} 条开票结果；部分成功的申请仍保留未完成部分。"
        self.attempt(run)

    @Slot(str,str)
    def archiveInvoice(self,billno,path):
        def run():
            from .archive import attach
            path=QUrl(path).toLocalFile() if path.startswith("file:") else path
            attach(self.store,billno.strip(),path)
            self.message="附件已按内容指纹归档，原文件未改动；归档不代表已自动验真。"
        self.attempt(run)

    @Slot()
    def backup(self):
        def run():self.message="数据备份已保存："+self.store.backup()
        self.attempt(run)

    def shutdown(self):
        self.cancel()
        if self.execution_proc:
            self.store.set("queue_paused",True)
            self.execution_proc.kill();self.execution_proc.waitForFinished(3000)
            self.queue.recover_interrupted()
