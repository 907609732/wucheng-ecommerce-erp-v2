# -*- coding: utf-8 -*-
"""
自动开票台账 —— 一键运行入口

用法（在本文件夹打开命令行，或双击 run.bat）：
    python run.py                     扫描「订单投放」，生成台账和开票模板
    python run.py --archive           跑完把原始文件移到「归档」
    python run.py --import-missing    把「待补录清单」里你补填的抬头税号写回抬头库
    python run.py --mark-issued 文件   把已开完票的结果登记进「已开票记录」，避免重复开票
    python run.py --sample            生成一份模拟订单，用来测试流程
    python run.py --gui               打开窗口版（进度 + 日志，推荐日常使用）

  窗口版也可以直接双击 run_gui.bat
"""
import os
import sys
from console_bridge import install_console_bridge
install_console_bridge()
import argparse

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from src.config import load_config
from runtime_paths import legacy_data_root

from src import pipeline  # noqa: E402
from src.reporter import ConsoleReporter, setup_logging  # noqa: E402


def load_cfg():
    return load_config(legacy_data_root())


def main():
    ap = argparse.ArgumentParser(description="电商订单 → 开票明细台账")
    ap.add_argument("--archive", action="store_true", help="处理完把原始文件归档")
    ap.add_argument("--import-missing", action="store_true", help="回补抬头库")
    ap.add_argument("--mark-issued", metavar="FILE", help="登记已开票记录")
    ap.add_argument("--sample", action="store_true", help="生成模拟订单用于测试")
    ap.add_argument("--gui", action="store_true", help="打开窗口版（进度条 + 实时日志）")
    ap.add_argument("--no-pause", action="store_true", help="运行后退出，供自动任务使用")
    ap.add_argument("--check", action="store_true", help="检查运行环境与配置")
    args = ap.parse_args()

    if args.gui:
        try:
            import gui  # noqa: F401
            gui.main()
        except ImportError:
            # 当前解释器没带 tkinter，换带 tkinter 的环境把窗口拉起来
            import subprocess
            pyw = r"C:\Users\90760\.workbuddy\binaries\python\envs\gui\Scripts\pythonw.exe"
            if os.path.exists(pyw):
                subprocess.Popen([pyw, os.path.join(BASE, "gui.py")])
            else:
                print("窗口版需要带 tkinter 的 Python，请直接双击 run_gui.bat")
        return

    cfg = load_cfg()

    if args.check:
        import openpyxl, xlrd, tkinter
        print(f"环境检查通过：Python {sys.version.split()[0]} / openpyxl {openpyxl.__version__} / xlrd {xlrd.__version__} / Tk {tkinter.TkVersion}")
        print("配置模式：", cfg.get("mode", "auto"))
        print("订单投放：", cfg["paths"]["incoming"])
        return

    if args.sample:
        from src.sample import make_samples
        make_samples(legacy_data_root())
        print("\n已生成模拟订单，直接运行 python run.py 看效果。")
        return

    if args.import_missing:
        pipeline.import_missing(cfg)
        return

    if args.mark_issued:
        pipeline.mark_issued(cfg, args.mark_issued)
        return

    log, logfile = setup_logging(legacy_data_root())
    print("=" * 62)
    print("  自动开票台账  |", cfg["seller"].get("name", ""))
    print("  日志文件：", logfile)
    print("=" * 62)
    outs = pipeline.run(cfg, archive=args.archive, reporter=ConsoleReporter(log))
    if outs:
        print("\n完成。下一步：")
        print("  1. 打开「待开票台账」核对金额与实际订单是否一致")
        if "待补录" in outs:
            print("  2. 打开「待补录清单」补填抬头/税号，然后运行 python run.py --import-missing")
        if "漏开票预警" in outs:
            print("  ! 有买家申请了开票但找不到订单，见「漏开票预警」，必须补导订单明细")
        print()
        print("  先打开本次「处理报告」，只使用报告列出的文件，修正异常后重新处理。")
        if "新福通申请单" in outs:
            print("  新福通：销项发票 → 开票申请单 → 导入本次申请单 → 核对 → 统一开票")
        else:
            print("  本次没有检查通过的新福通申请单；不要使用 output 中的旧导入文件。")
        print()
        print("  开完后登记一次，避免重复开票：python run.py --mark-issued 你的开票结果表.xlsx")
    if not args.no_pause and sys.stdin.isatty():
        input("\n按回车键关闭...")
    if not outs:
        return 1
    if "处理报告" in outs:
        import json
        with open(os.path.splitext(outs["处理报告"])[0] + ".json", encoding="utf-8") as f:
            status = json.load(f)["状态"]
        return 1 if status == "生成失败" else 2 if status == "待修正" else 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:
        print(f"处理失败：{e}", file=sys.stderr)
        sys.exit(1)
