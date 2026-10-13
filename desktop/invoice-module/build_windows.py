"""PyInstaller onedir build: portable executable + complete runtime, no customer data."""
from pathlib import Path
from datetime import datetime
import shutil
import subprocess
import sys


def main():
    root=Path(__file__).resolve().parent
    tag=datetime.now().strftime("%Y%m%d_%H%M%S")
    stage=root/"build"/("pyinstaller_"+tag)
    stage.mkdir(parents=True)
    shutil.copy2(root/"assistant.py",stage/"assistant.py")
    shutil.copytree(root/"invoice_assistant",stage/"invoice_assistant",ignore=shutil.ignore_patterns("__pycache__"))
    (stage/"src").mkdir()
    for name in ("__init__.py","readers.py","requests.py","fieldmap.py"):
        shutil.copy2(root/"src"/name,stage/"src"/name)
    (stage/"模板").mkdir()
    shutil.copyfile(root/"模板"/"新福通通用开票申请单模板.xlsx",stage/"模板"/"新福通通用开票申请单模板.xlsx")
    (stage/"config.yaml").write_text('seller: {}\ntax:\n  default_rate: "0.01"\n',encoding="utf-8")
    command=[sys.executable,"-m","PyInstaller","--noconfirm","--onedir","--windowed","--name","InvoiceAssistant",
        "--distpath",str(root/"release"/("pyinstaller_"+tag)),"--workpath",str(stage/"work"),
        "--collect-data","playwright","--hidden-import","keyring.backends.Windows","--hidden-import","pywinauto",
        "--add-data","invoice_assistant/Main.qml;invoice_assistant","--add-data","模板;模板","--add-data","config.yaml;.",
        "--exclude-module","PyQt5","--exclude-module","PyQt6","--exclude-module","tkinter","--exclude-module","pandas",
        "--exclude-module","matplotlib","--exclude-module","scipy","--exclude-module","numpy","assistant.py"]
    subprocess.run(command,cwd=stage,check=True)
    dest=root/"release"/("pyinstaller_"+tag)/"InvoiceAssistant"
    # The whole directory is the product, not the exe by itself.
    shutil.copy2(root/"README.md",dest/"README.md")
    from invoice_assistant.notices import collect
    collect(dest)
    if (root/"文档"/"开源调查与能力清单.md").exists():shutil.copy2(root/"文档"/"开源调查与能力清单.md",dest/"能力清单.md")
    if (root/"文档"/"测试报告.md").exists():shutil.copy2(root/"文档"/"测试报告.md",dest/"测试报告.md")
    if sys.platform=="win32":
        def quoted(path):return str(path).replace("'","''")
        command="$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('"+quoted(root/"电商自动开票助手.lnk")+"'); $s.TargetPath='"+quoted(dest/"InvoiceAssistant.exe")+"'; $s.WorkingDirectory='"+quoted(dest)+"'; $s.Save()"
        subprocess.run(["powershell","-NoProfile","-Command",command],check=True)
    print("Delivered directory:",dest,flush=True)


if __name__=="__main__":main()
