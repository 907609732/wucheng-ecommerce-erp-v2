"""命令行、窗口共用的配置入口。"""
import os
import math
import yaml


def load_config(base, path=None):
    with open(path or os.path.join(base, "config.yaml"), encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if not isinstance(cfg, dict):
        raise ValueError("config.yaml 必须是配置对象")
    for key in ("paths", "tax", "rules", "outputs", "seller"):
        if not isinstance(cfg.get(key), dict):
            raise ValueError(f"config.yaml 缺少配置段：{key}")
    if cfg.get("mode", "auto") not in ("auto", "erp", "platform"):
        raise ValueError("mode 只能填写 auto、erp 或 platform")
    rate = float(cfg["tax"].get("default_rate", 0.01))
    if not math.isfinite(rate) or not 0 <= rate <= 1:
        raise ValueError("default_rate 应为 0 到 1 的小数，例如 0.01")
    if int(cfg["rules"].get("max_lines_per_invoice", 100)) < 1:
        raise ValueError("max_lines_per_invoice 必须大于 0")
    cfg["_base"] = os.path.abspath(base)
    for key, value in cfg["paths"].items():
        cfg["paths"][key] = os.path.abspath(os.path.join(base, value))
    return cfg
