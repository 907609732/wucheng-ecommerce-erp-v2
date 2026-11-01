# Agent preview 紧凑安装布局

范围：固定 appId `com.wucheng.ecommerce.erp.v2.agentpreview` 与 profile `WuchengAgentBeta-preview`。仅改变部署布局，业务源码及原生组件 ASAR 保持原字节。正式版安装目录与账本不参与。

## 工具与布局

- `@vercel/nft@1.11.0` 分析真实 Node 入口；警告涉及的依赖包整包保留，浏览器静态资源明确保留。追踪结果是筛选依据，不能直接照删所有未追踪文件。
- 导出器外部 Node 入口无第三方依赖，原生应用的依赖仍在原 ASAR 内，因此去掉重复外置 node_modules。
- 采购、销售、经营的依赖采用 `yazl` ZIP64 内容归档，`yauzl` 解包。完整文件树和 SHA 相同的包只分发一份；各模块展开到自己的版本目录，保留 Node 原有依赖解析及静态资源路径，避免跨版本混用。
- 第一次激活时最多并行解包六份独立归档，核对每个展开文件的大小和 SHA；保存激活收据。所有可写缓存及账本放在预览专属 userData 目录。
- Agent 宿主从已激活模块加载适配器，避免仍然从已经精简的安装目录加载依赖。仓库里的业务服务与账本实现没有改动。
- 依赖的类型声明、未引用 sourcemap、测试、例子及文档不分发；许可证文本去重汇总至 `THIRD_PARTY_NOTICES.txt`。PDF、OCR、原生库及浏览器资源保留。
- Node 和浏览器离线 ZIP 保留。实际云仓含必需 ASAR，不作为空壳删除。
- 安装器使用原生 NSIS File 分支，`useZip:false`，关闭安装后自动运行。独立 appId 不变。长路径预检失败时明确退出，不留下貌似成功的不完整安装。

## 可复现命令

在冻结且通过原严格扫描的预览 snapshot 上执行。输入清单中的 `prepackaged` 必须指向实际短路径 snapshot；保留原始清单及重定位记录。

```powershell
npm.cmd install --global @vercel/nft@1.11.0 --ignore-scripts --no-audit --no-fund
node scripts/trace-preview-runtime.mjs VERIFIED_INPUTS SNAPSHOT TRACE_OUTPUT
node scripts/compact-agent-preview.mjs VERIFIED_INPUTS TRACE_OUTPUT/nft-trace-files.json TRACE_OUTPUT/nft-trace-report.json C:/short/new-preview/payload
node scripts/package-compact-agent-preview.mjs C:/short/new-preview/optimized-layout.json
```

新目录必须不存在；不要将产物写回冻结来源。压缩归档和扫描结果可以复用，部署文件变更后须重新生成 manifest、pin、完整清单及安装器。不能只改安装后的文件就宣布交付成功。

## 验收边界

最终交付必须包含实际 `/S` 的退出码、耗时、文件数和字节数；交互向导完成页；已安装程序的三个业务页面；Hermes ACP 初始化和真实模块依赖回归。安装目录大小不包含首次准备生成的 userData 缓存，需分别报告。

在 Codex MSIX 内直接派生进程可能继承 Windows LocalAppData 虚拟化，使严格 canonical 路径检查拒绝该进程。应通过 Windows Explorer / 已安装快捷方式验证真实用户启动；不要放松链接和路径检查。
