# 工作台0.11.3 / 采购台1.8.0发布记录

2026-10-27正式发布。以后默认只生成NSIS安装器，不生成或发布便携版。

- 发布页：https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/tag/0.11.3
- 完整安装器：https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/0.11.3/CloudWarehouseInventorySync-Setup-0.11.3-x64.exe
- 安装器SHA256：4e6c55725e71981f6fa25e3ce8070a6bbb3499824118e44b69617bf20e9bf73b
- 构建与整套验收：https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/40478363529

基线为已安装并验收的工作台0.11.2。只将采购台1.7.1升级至1.8.0，其他六个签名组件ZIP的版本及SHA256不变；工作区内其他未验收修改没有进入安装器。只修改主程序的产品版本及套件目录元数据，112个主程序第一方文件已验证与冻结输入一致。

采购台178项测试、生产包启动/19项任务/图像依赖/Excel导出通过。旧采购账本升级验证28张既有表无差异，原件和金额保留。GitHub Windows构建机完成完整离线激活、主页各入口打开、五个隔离账本及原件恢复保留验证，组件下载数为0。所有测试使用合成账本；本次没有安装覆盖本机正式工作台。

远端19项文件逐项核对GitHub SHA256与字节数，latest.yml与安装器匹配。正式文件由GitHub构建机生成，本地output中的首次候选EXE不是最终发布EXE；以published目录的清单及GitHub文件为准。临时构建输入已删除，单次构建流水线已停用，避免同版本重复覆盖。

源码分支codex/purchase-release-0.11.3，正式源码快照及流水线代码在该版本的release-sources目录与Verified-Source资产中。正式安装器未进行Windows代码签名。此版本发布后不可用同一版本号覆盖重打包；后续版本至少0.11.4。
