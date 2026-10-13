"""Exact-first column mapping avoids '买家' stealing '买家实际支付金额'."""
import re


def normalized(value):
    return re.sub(r"[\s*（）()]", "", str(value or "")).casefold()


def column_map(headers, source, request=False, overrides=None):
    if request:
        from src.requests import REQUEST_ALIASES, SOURCE_REQUEST_ALIASES
        common, specific = REQUEST_ALIASES, SOURCE_REQUEST_ALIASES.get(source,{})
    else:
        from src.fieldmap import COMMON_ALIASES, SOURCE_ALIASES
        common, specific = COMMON_ALIASES, SOURCE_ALIASES.get(source,{})
    normalized_headers=[normalized(h) for h in headers]
    overrides=overrides or {}
    allowed=set(common)|set(specific)
    if request:allowed|={"source_id","shop_id","source_invoice_no","refund_status"}
    if set(overrides)-allowed:raise ValueError("自定义映射含未知字段")
    result={}
    for key in dict.fromkeys([*specific,*common]):
        for alias in [*specific.get(key,[]),*common.get(key,[])]:
            hits=[i for i,h in enumerate(normalized_headers) if h==normalized(alias)]
            if len(hits)>1:
                raise ValueError("导出文件存在重复表头，请核对："+str(alias))
            if hits:
                if hits[0] in result.values():
                    raise ValueError("同一列被识别为多个字段，请核对："+str(alias))
                result[key]=hits[0]
                break
    for key,header in overrides.items():
        hits=[i for i,h in enumerate(normalized_headers) if h==normalized(header)]
        if len(hits)!=1:raise ValueError("自定义映射列不存在或不唯一："+str(header))
        result[key]=hits[0]
    if len(set(result.values()))!=len(result):raise ValueError("多个字段映射到同一列，请修正配置")
    return result
