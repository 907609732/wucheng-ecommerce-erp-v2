"""Use Qt's official deploy tool against a clean staging tree, never package customer history."""
from pathlib import Path
import configparser
import os
import shutil
import subprocess
import sys
from datetime import datetime


def main():
    root=Path(__file__).resolve().parent
    stage=root/"build"/("v2_"+datetime.now().strftime("%Y%m%d_%H%M%S"))
    stage.mkdir(parents=True)
    shutil.copy2(root/"assistant.py",stage/"assistant.py")
    shutil.copytree(root/"invoice_assistant",stage/"invoice_assistant",ignore=shutil.ignore_patterns("__pycache__"))
    (stage/"src").mkdir()
    for name in ("__init__.py","readers.py","requests.py","fieldmap.py"):
        shutil.copy2(root/"src"/name,stage/"src"/name)
    (stage/"模板").mkdir()
    shutil.copyfile(root/"模板"/"新福通通用开票申请单模板.xlsx",stage/"模板"/"新福通通用开票申请单模板.xlsx")
    # Do not embed seller identity or runtime configuration in a portable executable.
    (stage/"config.yaml").write_text('seller: {}\ntax:\n  default_rate: "0.01"\n',encoding="utf-8")
    tool=Path(sys.executable).parent/"Scripts"/"pyside6-deploy.exe"
    subprocess.run([str(tool),"assistant.py","--init","--force","--mode","standalone","--name","InvoiceAssistant"],cwd=stage,check=True)
    spec=stage/"pysidedeploy.spec"
    cfg=configparser.ConfigParser(interpolation=None);cfg.read(spec,encoding="utf-8")
    cfg["python"]["packages"]="Nuitka==2.8.10,ordered-set,zstandard"
    cfg["app"]["exec_directory"]=str(stage/"release")
    cfg["qt"]["modules"]="Core,Gui,Qml,Quick,QuickControls2,Network"
    cfg["qt"]["qml_files"]="invoice_assistant/Main.qml"
    cfg["nuitka"]["extra_args"]="--noinclude-qt-translations --assume-yes-for-downloads --msvc=latest --include-package=invoice_assistant --include-package=src --include-package-data=playwright --include-data-files=config.yaml=config.yaml --windows-console-mode=disable"
    with spec.open("w",encoding="utf-8") as f:cfg.write(f)
    print("Clean deployment stage:",stage,flush=True)
    result=subprocess.run([str(tool),"assistant.py","--force","--keep-deployment-files","--mode","standalone"],cwd=stage)
    # Qt 6.8 copies the exe only; standalone DLLs/data must be delivered as the entire .dist tree.
    dist=stage/"deployment"/"assistant.dist"
    if result.returncode or not (dist/"assistant.exe").exists():
        raise SystemExit("打包未完成；保留 stage 及日志供修复："+str(stage))
    dest=root/"release"/("开票助手_v2_"+datetime.now().strftime("%Y%m%d_%H%M%S"))
    shutil.copytree(dist,dest)
    print("Standalone runtime:",dest,flush=True)
    if os.name=="nt":
        # A visible shortcut is a requested delivery artifact, not a background interactive process.
        command="$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('"+str(root/"新版开票助手.lnk").replace("'","''")+"'); $s.TargetPath='"+str(dest/"assistant.exe").replace("'","''")+"'; $s.WorkingDirectory='"+str(dest).replace("'","''")+"'; $s.Save()"
        subprocess.run(["powershell","-NoProfile","-Command",command],check=True)


if __name__=="__main__":main()
