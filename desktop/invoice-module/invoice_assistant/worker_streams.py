"""Restore inherited Qt pipes for windowed frozen worker processes on Windows."""
import io
import os
import sys


def ensure_worker_streams():
    for name,handle_id,mode in (("stdin",-10,"r"),("stdout",-11,"w"),("stderr",-12,"w")):
        existing=getattr(sys,name)
        if existing is not None:
            if hasattr(existing,"reconfigure"):
                existing.reconfigure(encoding="utf-8",errors="strict",**({"line_buffering":True} if mode=="w" else {}))
            continue
        stream=None
        if sys.platform=="win32":
            import ctypes
            import msvcrt
            from ctypes import wintypes
            kernel=ctypes.WinDLL("kernel32",use_last_error=True)
            kernel.GetStdHandle.argtypes=[wintypes.DWORD]
            kernel.GetStdHandle.restype=wintypes.HANDLE
            handle=kernel.GetStdHandle(handle_id & 0xffffffff)
            if handle and handle!=ctypes.c_void_p(-1).value:
                try:
                    flags=os.O_RDONLY if mode=="r" else os.O_WRONLY
                    fd=msvcrt.open_osfhandle(handle,flags)
                    stream=os.fdopen(fd,mode,encoding="utf-8",buffering=1)
                except OSError:pass
        if stream is None:
            stream=io.StringIO() if mode=="r" else open(os.devnull,mode,encoding="utf-8")
        setattr(sys,name,stream)
