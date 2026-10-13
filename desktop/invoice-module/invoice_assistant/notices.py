"""Copy installed dependency license notices into the generated distribution."""
from pathlib import Path
import importlib.metadata as metadata
import sys
import shutil


def collect(destination):
    destination=Path(destination)
    root=destination/"第三方许可"
    root.mkdir(parents=True,exist_ok=True)
    records=[]
    for package in ("PySide6","PySide6_Essentials","PySide6_Addons","shiboken6","openpyxl","xlrd","PyYAML","playwright","pywinauto","winocr","Pillow","winrt-runtime","winrt-windows-foundation-collections","winrt-windows-foundation","winrt-windows-globalization","winrt-windows-graphics-imaging","winrt-windows-media-ocr","winrt-windows-storage-streams","keyring","pyinstaller"):
        try:dist=metadata.distribution(package)
        except metadata.PackageNotFoundError:continue
        paths=[]
        for file in dist.files or []:
            if any(part.casefold() in ("licenses","licences","license","licence","copying","copyright") for part in file.parts) or file.name.casefold().startswith(("license","licence","copying","copyright","lgpl","gpl")):
                source=Path(dist.locate_file(file))
                if not source.is_file():continue
                # Preserve metadata-relative paths without trusting parent traversal.
                parts=[part for part in file.parts if part not in ("..",".")]
                target=root/package/Path(*parts)
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(source,target)
                paths.append(str(target.relative_to(destination)))
        records.append(package+" "+dist.version+"\n"+str(dist.metadata.get("License-Expression") or dist.metadata.get("License") or "许可详见上游")+"\n"+"\n".join(paths))
    python_license=Path(sys.base_prefix)/"LICENSE.txt"
    if python_license.exists():shutil.copyfile(python_license,root/"Python-LICENSE.txt")
    qt_notices=Path(__file__).resolve().parents[1]/"文档"/"许可"/"Qt-6.8.3"
    if qt_notices.exists():
        shutil.copytree(qt_notices,root/"Qt-6.8.3",dirs_exist_ok=True)
        records.append("Qt 6.8.3 开源许可原文：第三方许可/Qt-6.8.3；来源 qt/qtbase v6.8.3 LICENSES")
    (destination/"THIRD_PARTY_NOTICES.txt").write_text("本地依赖许可清单。保留动态库与许可文本；不构成完整法律合规审计。\n\n"+"\n\n".join(records),encoding="utf-8")
