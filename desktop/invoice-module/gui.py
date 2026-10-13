# -*- coding: utf-8 -*-
"""
自动开票台账 —— 前台窗口

左边：6 个步骤的实时状态（待处理 / 进行中 / 完成 / 失败 / 跳过）
中间：每一步的详细日志，滚动输出，警告黄色、错误红色
底部：总进度条 + 用时 + 按钮（开始 / 打开输出 / 打开投放 / 打开日志）

所有日志同时写进「日志/运行日志_日期时间.log」，关了窗口也能查。
"""
import os
import re
import sys
import queue
import threading
import subprocess
import time
import traceback

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

# pythonw 下没有控制台，print 会炸，先兜住
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="ignore")
if sys.stderr is None:
    sys.stderr = sys.stdout

import tkinter as tk
from tkinter import ttk, messagebox, filedialog

from src.config import load_config
from runtime_paths import legacy_data_root

from src import pipeline
from src.reporter import setup_logging, QueueReporter, STEP_NAMES, N_STEPS

CFG_PATH = os.path.join(legacy_data_root(), "config.yaml")

# ---------------------------------------------------------------- 配色
C_BG       = "#f4f6f9"
C_CARD     = "#ffffff"
C_TEXT     = "#1f2328"
C_SUB      = "#6b7280"
C_LINE     = "#e3e6ea"
C_PENDING  = "#9aa1ab"
C_RUNNING  = "#1a73e8"
C_DONE     = "#1e8e3e"
C_FAIL     = "#d93025"
C_SKIP     = "#e8912d"

STATUS_ICON = {
    "pending": ("○", "待处理", C_PENDING),
    "running": ("◐", "进行中", C_RUNNING),
    "done":    ("●", "已完成", C_DONE),
    "fail":    ("✕", "失败",   C_FAIL),
    "skip":    ("⊘", "已跳过", C_SKIP),
}

FONT      = ("Microsoft YaHei UI", 9)
FONT_B    = ("Microsoft YaHei UI", 9, "bold")
FONT_BIG  = ("Microsoft YaHei UI", 13, "bold")
FONT_MONO = ("Consolas", 9)


def load_cfg():
    return load_config(legacy_data_root())


def set_cfg_mode(mode):
    """把窗口上选的模式写回 config.yaml，下次打开默认就是它"""
    try:
        with open(CFG_PATH, "r", encoding="utf-8") as f:
            text = f.read()
        new = re.sub(r"(?m)^mode:.*$", f"mode: {mode}", text, count=1)
        if new != text:
            with open(CFG_PATH, "w", encoding="utf-8") as f:
                f.write(new)
    except Exception:
        pass


class App:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.cfg = load_cfg()
        self.running = False
        self.t0 = 0
        self.cur_pct = 0.0
        self.target_pct = 0.0
        self.outs = {}
        self.logfile = ""
        self.logger = None
        self.done_steps = 0

        root.title("自动开票台账  ·  " + self.cfg["seller"].get("name", ""))
        root.geometry("1060x780")
        root.minsize(980, 720)
        root.configure(bg=C_BG)
        self._style()

        self._build_header()
        self._build_body()
        self._build_footer()

        self.root.after(80, self._poll)

    # ------------------------------------------------------------ 样式
    def _style(self):
        s = ttk.Style()
        try:
            s.theme_use("clam")
        except Exception:
            pass
        s.configure("TFrame", background=C_BG)
        s.configure("Card.TFrame", background=C_CARD, relief="flat")
        s.configure("TLabel", background=C_BG, foreground=C_TEXT, font=FONT)
        s.configure("Card.TLabel", background=C_CARD, foreground=C_TEXT, font=FONT)
        s.configure("Sub.TLabel", background=C_BG, foreground=C_SUB, font=FONT)
        s.configure("Card.Sub.TLabel", background=C_CARD, foreground=C_SUB, font=FONT)
        s.configure("Title.TLabel", background=C_CARD, foreground=C_TEXT, font=FONT_BIG)
        s.configure("TButton", font=FONT, padding=(12, 6))
        s.configure("Go.TButton", font=FONT_B, padding=(16, 7))
        s.configure("TCheckbutton", background=C_CARD, font=FONT)
        s.configure("TRadiobutton", background=C_CARD, font=FONT)
        s.configure("Bar.Horizontal.TProgressbar", troughcolor="#e8ebef",
                    background=C_RUNNING, borderwidth=0, thickness=10)

    # ------------------------------------------------------------ 头部
    def _build_header(self):
        top = ttk.Frame(self.root, style="Card.TFrame", padding=(16, 12))
        top.pack(fill="x", padx=12, pady=(12, 8))

        left = ttk.Frame(top, style="Card.TFrame")
        left.pack(side="left", fill="x", expand=True)

        ttk.Label(left, text="自动开票台账", style="Title.TLabel").pack(anchor="w")
        mode_cn = {"erp": "ERP 导出模式（聚水潭）",
                   "platform": "平台导出模式（拼多多/淘宝等）",
                   "auto": "自动识别模式"}.get(str(self.cfg.get("mode", "auto")).lower(), "自动识别模式")
        self.lbl_sub = ttk.Label(
            left,
            text=f"{self.cfg['seller'].get('name', '')}　|　税率 "
                 f"{float(self.cfg['tax'].get('default_rate', 0.01)) * 100:g}%　|　当前：{mode_cn}",
            style="Card.Sub.TLabel")
        self.lbl_sub.pack(anchor="w", pady=(3, 0))

        # 模式切换
        box = ttk.Frame(top, style="Card.TFrame")
        box.pack(side="right")
        ttk.Label(box, text="开票数据来源：", style="Card.TLabel").pack(side="left", padx=(0, 6))
        self.var_mode = tk.StringVar(value=str(self.cfg.get("mode", "auto")).lower())
        for v, t in (("auto", "自动识别"), ("erp", "ERP 导出"), ("platform", "平台导出")):
            ttk.Radiobutton(box, text=t, value=v, variable=self.var_mode).pack(side="left", padx=4)
        self.var_archive = tk.BooleanVar(value=False)
        ttk.Checkbutton(box, text="处理完归档原文件", variable=self.var_archive).pack(side="left", padx=(12, 0))

    # ------------------------------------------------------------ 主体
    def _build_body(self):
        body = ttk.Frame(self.root, padding=0)
        body.pack(fill="both", expand=True, padx=12, pady=(0, 8))

        # ---- 左：步骤状态
        left = ttk.Frame(body, style="Card.TFrame", padding=(14, 12))
        left.pack(side="left", fill="y", padx=(0, 8))
        left.configure(width=340)
        ttk.Label(left, text="处理步骤", font=FONT_B, style="Card.TLabel").pack(anchor="w")
        ttk.Separator(left).pack(fill="x", pady=(6, 10))

        self.rows = {}
        wrap = ttk.Frame(left, style="Card.TFrame")
        wrap.pack(fill="both", expand=True)
        for i, name in enumerate(STEP_NAMES, start=1):
            r = ttk.Frame(wrap, style="Card.TFrame")
            r.pack(fill="x", pady=3)
            num = tk.Label(r, text=str(i), width=2, anchor="center",
                           bg=C_CARD, fg=C_PENDING, font=FONT_B)
            num.pack(side="left")
            nm = tk.Label(r, text=name, anchor="w", bg=C_CARD, fg=C_TEXT, font=FONT, width=19)
            nm.pack(side="left", padx=(6, 0))
            st = tk.Label(r, text="待处理", anchor="w", bg=C_CARD, fg=C_PENDING, font=FONT)
            st.pack(side="right")
            self.rows[i] = (num, nm, st)

        ttk.Separator(left).pack(fill="x", pady=10)
        ttk.Label(left, text="本次生成", font=FONT_B, style="Card.TLabel").pack(anchor="w")
        self.out_box = ttk.Frame(left, style="Card.TFrame")
        self.out_box.pack(fill="x", pady=(6, 0))
        self.lbl_noout = ttk.Label(self.out_box, text="——", style="Card.Sub.TLabel")
        self.lbl_noout.pack(anchor="w")

        # ---- 右：日志
        right = ttk.Frame(body, style="Card.TFrame", padding=(12, 10))
        right.pack(side="left", fill="both", expand=True)

        head = ttk.Frame(right, style="Card.TFrame")
        head.pack(fill="x")
        ttk.Label(head, text="运行日志", font=FONT_B, style="Card.TLabel").pack(side="left")
        self.lbl_time = ttk.Label(head, text="", style="Card.Sub.TLabel")
        self.lbl_time.pack(side="right")

        box = tk.Frame(right, bg=C_CARD)
        box.pack(fill="both", expand=True, pady=(6, 0))
        self.txt = tk.Text(box, wrap="word", font=FONT_MONO, bg="#fbfcfd", fg=C_TEXT,
                           relief="solid", bd=1, highlightthickness=0, height=16,
                           insertbackground=C_TEXT, padx=8, pady=6)
        sb = ttk.Scrollbar(box, command=self.txt.yview)
        self.txt.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.txt.pack(side="left", fill="both", expand=True)
        for tag, color in (("info", C_TEXT), ("ok", C_DONE), ("warning", C_SKIP),
                           ("error", C_FAIL), ("step", C_RUNNING), ("dim", C_SUB)):
            self.txt.tag_config(tag, foreground=color)
        self.txt.tag_config("step", font=("Consolas", 9, "bold"))
        self.txt.configure(state="disabled")

    # ------------------------------------------------------------ 底部
    def _build_footer(self):
        ft = ttk.Frame(self.root, style="Card.TFrame", padding=(16, 10))
        ft.pack(fill="x", padx=12, pady=(0, 12))

        self.var_pct = tk.StringVar(value="就绪")
        self.pb = ttk.Progressbar(ft, style="Bar.Horizontal.TProgressbar",
                                  orient="horizontal", mode="determinate", maximum=100)
        self.pb.pack(fill="x")
        self.lbl_pct = ttk.Label(ft, textvariable=self.var_pct, style="Card.Sub.TLabel")
        self.lbl_pct.pack(anchor="w", pady=(4, 8))

        bar = ttk.Frame(ft, style="Card.TFrame")
        bar.pack(fill="x")
        self.btn_run = ttk.Button(bar, text="▶  开始处理", style="Go.TButton", command=self.start)
        self.btn_run.pack(side="left")
        ttk.Button(bar, text="打开输出文件夹", command=lambda: self._open(self._outdir())).pack(side="left", padx=6)
        ttk.Button(bar, text="打开订单投放", command=lambda: self._open(os.path.join(legacy_data_root(), "订单投放"))).pack(side="left")
        ttk.Button(bar, text="生成测试订单", command=self.make_sample).pack(side="left", padx=6)
        ttk.Button(bar, text="查看日志文件", command=self.open_log).pack(side="left")
        ttk.Button(bar, text="退出", command=self.root.destroy).pack(side="right")
        actions = ttk.Frame(ft, style="Card.TFrame")
        actions.pack(fill="x", pady=(8, 0))
        ttk.Button(actions, text="补录回写", command=self.import_missing).pack(side="left")
        ttk.Button(actions, text="登记已开票", command=self.mark_issued).pack(side="left", padx=6)
        ttk.Button(actions, text="商品编码库", command=lambda: self._open_file(self.cfg["paths"]["taxcode_lib"])).pack(side="left")
        ttk.Button(actions, text="开票配置", command=lambda: self._open_file(CFG_PATH)).pack(side="left", padx=6)

    def import_missing(self):
        if self.running:
            return
        path = filedialog.askopenfilename(title="选择已填写完成的待补录清单", initialdir=self._outdir(), filetypes=[("Excel", "*.xlsx")])
        if path:
            try:
                n = pipeline.import_missing(load_cfg(), path)
                messagebox.showinfo("补录完成", f"已写入 {n} 条订单抬头。请重新处理；原库已备份。")
            except Exception as e:
                messagebox.showerror("回写失败", str(e))

    def mark_issued(self):
        if self.running:
            return
        path = filedialog.askopenfilename(title="选择实际开票成功的结果表（平台订单号、发票号码）", initialdir=self._outdir(), filetypes=[("结果表", "*.xlsx *.xls *.csv")])
        if path:
            try:
                n = pipeline.mark_issued(load_cfg(), path)
                messagebox.showinfo("登记完成", f"已登记 {n} 条订单；再次处理时自动跳过。原库已备份。")
            except Exception as e:
                messagebox.showerror("登记失败", str(e))

    # ------------------------------------------------------------ 工具
    def _outdir(self):
        return self.cfg["paths"]["output"]

    def _open(self, path):
        try:
            os.makedirs(path, exist_ok=True)
            if os.name == "nt":
                os.startfile(path)
            else:
                subprocess.Popen(["open", path])
        except Exception as e:
            messagebox.showerror("打不开", f"{path}\n{e}")

    def _log(self, msg, level="info"):
        self.txt.configure(state="normal")
        ts = time.strftime("%H:%M:%S")
        if level == "step":
            self.txt.insert("end", f"\n{ts}  ", "dim")
            self.txt.insert("end", f"{msg}\n", "step")
        else:
            self.txt.insert("end", f"{ts}  ", "dim")
            self.txt.insert("end", f"{msg}\n", level)
        self.txt.see("end")
        self.txt.configure(state="disabled")

    def _clear(self):
        self.txt.configure(state="normal")
        self.txt.delete("1.0", "end")
        self.txt.configure(state="disabled")
        for w in self.out_box.winfo_children():
            w.destroy()
        self.lbl_noout = ttk.Label(self.out_box, text="——", style="Card.Sub.TLabel")
        self.lbl_noout.pack(anchor="w")

    def _set_step(self, i, state, note=""):
        num, nm, st = self.rows[i]
        icon, text, color = STATUS_ICON[state]
        num.config(text=icon, fg=color)
        nm.config(fg=C_TEXT if state != "pending" else C_SUB)
        st.config(text=(note or text), fg=color)
        self.step_state[i] = state

    def _reset_steps(self):
        self.step_state = {}
        for i in range(1, N_STEPS + 1):
            self._set_step(i, "pending")

    # ------------------------------------------------------------ 执行
    def make_sample(self):
        if self.running:
            return
        try:
            from src.sample import make_samples
            make_samples(legacy_data_root())
            messagebox.showinfo("好了", "已在「订单投放」生成模拟订单，点「开始处理」看效果。")
        except Exception as e:
            messagebox.showerror("失败", str(e))

    def open_log(self):
        if self.logfile and os.path.exists(self.logfile):
            self._open_file(self.logfile)
        else:
            d = os.path.join(legacy_data_root(), "日志")
            if not os.path.isdir(d):
                messagebox.showinfo("日志", "还没有运行过，暂无日志。")
                return
            fs = sorted([os.path.join(d, f) for f in os.listdir(d) if f.endswith(".log")])
            if fs:
                self._open_file(fs[-1])

    def _open_file(self, p):
        try:
            os.startfile(p) if os.name == "nt" else subprocess.Popen(["open", p])
        except Exception as e:
            messagebox.showerror("打不开", f"{p}\n{e}")

    def start(self):
        if self.running:
            return
        mode = self.var_mode.get()
        set_cfg_mode(mode)
        try:
            self.cfg = load_cfg()
        except Exception as e:
            messagebox.showerror("配置错误", str(e))
            return
        self.cfg["mode"] = mode

        self._clear()
        self._reset_steps()
        self.running = True
        self.done_steps = 0
        self.cur_pct = 0.0
        self.target_pct = 0.0
        self.pb["value"] = 0
        self.btn_run.config(text="●  处理中…", state="disabled")
        self.lbl_time.config(text="")
        self.t0 = time.time()
        archive = self.var_archive.get()

        # 日志只写文件（不带队列 handler），窗口日志由 QueueReporter 单独推，避免重复两行
        self.logger, self.logfile = setup_logging(legacy_data_root())
        R = QueueReporter(self.q, self.logger)

        self._log(f"开始处理　模式={ {'auto':'自动识别','erp':'ERP 导出','platform':'平台导出'}[mode] }"
                  f"　税率 {float(self.cfg['tax'].get('default_rate', 0.01)) * 100:g}%", "step")
        self._log(f"日志文件：{self.logfile}", "dim")

        def work():
            try:
                pipeline.run(self.cfg, archive=archive, reporter=R)
            except Exception:
                self.q.put(("log", "程序异常：\n" + traceback.format_exc(), "error"))
                self.q.put(("crash", None, None))

        threading.Thread(target=work, daemon=True).start()

    # ------------------------------------------------------------ 轮询
    def _poll(self):
        try:
            while True:
                ev = self.q.get_nowait()
                self._handle(ev)
        except queue.Empty:
            pass

        if self.running:
            # 进度条平滑推进
            if self.cur_pct < self.target_pct:
                self.cur_pct = min(self.target_pct, self.cur_pct + max(0.8, (self.target_pct - self.cur_pct) * 0.18))
                self.pb["value"] = self.cur_pct
            el = time.time() - self.t0
            self.lbl_time.config(text=f"已用时 {el:.1f}s")
            self.var_pct.set(f"处理中… {int(self.cur_pct)}%　（第 {min(self.done_steps + 1, N_STEPS)}/{N_STEPS} 步）")

        self.root.after(80, self._poll)

    def _handle(self, ev):
        kind = ev[0]
        if kind == "log":
            self._log(ev[1], ev[2] if ev[2] in ("info", "warning", "error") else "info")
        elif kind == "step_start":
            i = ev[1]
            self._set_step(i, "running")
            self.target_pct = (i - 1) / N_STEPS * 100
            self._log(f"[步骤 {i}/{N_STEPS}] {ev[2]}", "step")
            # 上一步没被显式收尾（既没 done 也没 fail）时，补成完成
            if i > 1 and self.step_state.get(i - 1) == "running":
                self._set_step(i - 1, "done")
        elif kind == "step_done":
            i = ev[1]
            self._set_step(i, "done", "已完成")
            self.done_steps = i
            self.target_pct = i / N_STEPS * 100
            if ev[2]:
                self._log(f"    ✔ {ev[2]}", "ok")
        elif kind == "step_fail":
            i = ev[1]
            self._set_step(i, "fail", "失败")
            self.done_steps = i
            self.target_pct = i / N_STEPS * 100
            self._log(f"    ✕ {ev[2]}", "error")
        elif kind == "step_skip":
            i = ev[1]
            self._set_step(i, "skip", "已跳过")
            self.done_steps = i
            self.target_pct = i / N_STEPS * 100
            if ev[2]:
                self._log(f"    ⊘ 跳过：{ev[2]}", "warning")
        elif kind == "finish":
            ok, outs = ev[1], ev[2]
            self.running = False
            self.cur_pct = self.target_pct = 100.0
            self.pb["value"] = 100
            el = time.time() - self.t0
            self.btn_run.config(text="▶  再跑一次", state="normal")
            self.lbl_time.config(text=f"用时 {el:.1f}s")
            if ok:
                self.var_pct.set(f"完成　100%　用时 {el:.1f}s")
                self._log("全部步骤执行完毕", "step")
            else:
                self.var_pct.set("未成功完成，看上面的红色日志")
                self.pb.configure(style="Bar.Horizontal.TProgressbar")
            self._show_outs(outs)
            self.outs = outs
            if "处理报告" in outs:
                import json
                try:
                    with open(os.path.splitext(outs["处理报告"])[0] + ".json", encoding="utf-8") as f:
                        report = json.load(f)
                    self.var_pct.set(f"{report['状态']}　通过 {report['可导出行数']} 行 / 待修正 {report['待修正行数']} 行　点击处理报告查看下一步")
                except (OSError, ValueError):
                    pass
        elif kind == "crash":
            self.running = False
            self.btn_run.config(text="▶  重试", state="normal")
            self.var_pct.set("程序异常，已中止")
            self.lbl_time.config(text="")

    def _show_outs(self, outs):
        for w in self.out_box.winfo_children():
            w.destroy()
        if not outs:
            ttk.Label(self.out_box, text="本次没有生成文件", style="Card.Sub.TLabel").pack(anchor="w")
            return
        for k, p in outs.items():
            row = ttk.Frame(self.out_box, style="Card.TFrame")
            row.pack(fill="x", pady=2)
            ttk.Label(row, text="● " + k, style="Card.TLabel", foreground=C_DONE, width=12).pack(side="left")
            b = ttk.Button(row, text=os.path.basename(p), command=lambda pp=p: self._open_file(pp))
            b.pack(side="left", fill="x", expand=True)


def main():
    root = tk.Tk()
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
