# -*- coding: utf-8 -*-
"""
日志与进度上报

同一个 Reporter 接口，两种实现：
  ConsoleReporter —— 命令行模式，直接打印
  QueueReporter   —— 窗口模式，把状态和日志推进队列，由窗口主线程消费

同时每一步都会写进日志文件（日志/运行日志_日期时间.log），方便事后排查。
"""
import logging
import os
import queue
from datetime import datetime

STEP_NAMES = [
    "加载配置与对照库",
    "扫描订单文件",
    "解析订单与匹配抬头",
    "汇总发票",
    "生成开票表格",
    "完成",
]
N_STEPS = len(STEP_NAMES)


class QueueLogHandler(logging.Handler):
    """把日志推进队列，送给窗口显示"""

    def __init__(self, q):
        super().__init__()
        self.q = q
        self.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))

    def emit(self, record):
        try:
            self.q.put(("log", self.format(record), record.levelname))
        except Exception:
            pass


def setup_logging(base, q=None):
    """初始化日志：文件必写，窗口可选。返回 (logger, 日志文件路径)"""
    logdir = os.path.join(base, "日志")
    os.makedirs(logdir, exist_ok=True)
    path = os.path.join(logdir, f"运行日志_{datetime.now():%Y%m%d_%H%M%S}.log")

    logger = logging.getLogger("invoice")
    logger.setLevel(logging.DEBUG)
    for h in list(logger.handlers):
        logger.removeHandler(h)
        h.close()

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    if q is not None:
        logger.addHandler(QueueLogHandler(q))

    return logger, path


class ConsoleReporter:
    """命令行模式"""

    def __init__(self, log=None):
        self.log = log

    def step(self, i, name):
        print(f"\n[{i}/{N_STEPS}] {name}", flush=True)
        if self.log:
            self.log.info(f"---- 步骤 {i}/{N_STEPS} {name}")

    def detail(self, msg, level="info"):
        print(f"  {msg}", flush=True)
        if self.log:
            getattr(self.log, level, self.log.info)(msg)

    def done(self, i, msg=""):
        if msg:
            print(f"  → {msg}", flush=True)
        if self.log and msg:
            self.log.info(f"步骤 {i} 完成：{msg}")

    def fail(self, i, msg):
        print(f"  !! {msg}", flush=True)
        if self.log:
            self.log.error(f"步骤 {i} 失败：{msg}")

    def skip(self, i, msg=""):
        print(f"  → 跳过：{msg}", flush=True)
        if self.log:
            self.log.info(f"步骤 {i} 跳过：{msg}")

    def finish(self, ok, outs=None):
        pass


class QueueReporter:
    """窗口模式"""

    def __init__(self, q, log=None):
        self.q = q
        self.log = log

    def step(self, i, name):
        self.q.put(("step_start", i, name))
        if self.log:
            self.log.info(f"---- 步骤 {i}/{N_STEPS} {name}")

    def detail(self, msg, level="info"):
        self.q.put(("log", msg, level))
        if self.log:
            getattr(self.log, level, self.log.info)(msg)

    def done(self, i, msg=""):
        self.q.put(("step_done", i, msg))
        if self.log and msg:
            self.log.info(f"步骤 {i} 完成：{msg}")

    def fail(self, i, msg):
        self.q.put(("step_fail", i, msg))
        if self.log:
            self.log.error(f"步骤 {i} 失败：{msg}")

    def skip(self, i, msg=""):
        self.q.put(("step_skip", i, msg))
        if self.log:
            self.log.info(f"步骤 {i} 跳过：{msg}")

    def finish(self, ok, outs=None):
        self.q.put(("finish", ok, outs or {}))
