"""Restore Python stdout/stderr from Electron pipes when launched via pythonw.exe.

Windows pythonw sets sys.std* to None even with redirected OS handles. This
bridge lets uncaught tracebacks and existing print diagnostics reach the ERP's
invoice log without changing the module's own business logging.
"""
import os
import sys


def install_console_bridge():
    for name, fd in (("stdout", 1), ("stderr", 2)):
        if getattr(sys, name) is None:
            try:
                stream = os.fdopen(os.dup(fd), "w", encoding="utf-8", errors="replace", buffering=1)
            except OSError:
                stream = open(os.devnull, "w", encoding="utf-8")
            setattr(sys, name, stream)
