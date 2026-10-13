# ERP 内的独立开票模块

代码与模板均位于本目录：五步开票助手 `assistant.py`、独立巡检 `invoice_watch.py`、旧版文件台账 `run.py`/`gui.py`、业务实现 `invoice_assistant/` 与 `src/`。Electron 只负责通过 IPC 启动独立 Python 子进程；开票逻辑不导入 ERP 库存模块。打包时本目录随测试版安装到 `resources/invoice-module/`（asar 外），不包含任何生产配置和个人数据。

需要本机 Python 3.12 及 `requirements.txt` 中的运行依赖（含 PySide6、Playwright 浏览器）。ERP 当前 Windows 启动器查找 `%LOCALAPPDATA%/Programs/Python/Python312/pythonw.exe`；这不是随包自带的 Python，换机器需另行安装依赖。

运行数据不在本目录：五步助手和原巡检继续使用 `%LOCALAPPDATA%/WuchengInvoiceAssistant/{Runtime,Monitoring}`；旧版文件台账使用 `%LOCALAPPDATA%/WuchengInvoiceAssistant/Legacy`。首次迁移已从旧工作区**复制** `config.yaml`、`数据/`、`订单投放/`、`output/`、`日志/`（不会覆盖目标同名文件）；旧目录仍保留。其生产配置含敏感资料，绝不可提交到仓库。删除旧工作区前，请在新安装包上核对店铺、模板、历史记录与输出，备份整个 `%LOCALAPPDATA%/WuchengInvoiceAssistant`，并验证真实登录流程。

在本目录运行单元测试：`C:/Users/90760/AppData/Local/Programs/Python/Python312/python.exe -m pytest tests -q`；GUI 隔离冒烟：`python assistant.py --demo --screenshot <临时文件>`。测试夹具不读取生产配置。千牛真实采集、钉钉投递与实际税务系统提交须另外验收，不能用模拟测试替代。
