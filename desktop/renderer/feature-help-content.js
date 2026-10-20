window.erpFeatureHelpContent = {
  "home": {
    "title": "功能主页",
    "summary": "首页提供云仓同步、采购台、销售台三个入口；采购和销售使用独立后台及原有账本。设置与服务位于全局工具栏。",
    "manual": [
      {
        "title": "选择功能",
        "ordered": true,
        "items": [
          "云仓库存同步：采集菜鸟库存、校验数据、查看库存与云仓月度销量，并按配置发送钉钉提醒。",
          "采购台：打开原有采购账本；左侧历史订单导入会拉起独立导出台，采集后需在采购台逐单、整批两次确认才能入账。",
          "销售台：打开原有销售账单、运费和对账功能；经营收支总览入口位于销售台内。",
          "公共设置：配置运行角色、账号、计划、钉钉、远程访问和软件更新。进入后先阅读本页说明。"
        ]
      },
      {
        "title": "使用约定",
        "items": [
          "右上角返回主页不代表停止正在执行的任务。采集的状态与日志应在所属模块检查。",
          "登录或验证码由本人在正常平台页面处理；不把失败、未登录或未下载当成零数据。",
          "采购、销售与总览切换时保留页面；后台在主窗口退出后继续运行，可在设置中查看状态并在空闲时停止。"
        ]
      }
    ],
    "principle": [
      {
        "title": "页面与业务分离",
        "items": [
          "本程序是 Electron 桌面应用；云仓沿用原业务面板，采购、销售和总览使用隔离的 WebContentsView，写入由所属服务处理。",
          "界面经 preload 的 inventoryApp 调用主进程 IPC；文件、数据库和自动化在主进程或 worker 中执行，不把密钥直接放入页面。",
          "说明由本地 feature-help-content.js 提供，使用文本节点渲染，不访问外网、不调用采集 IPC。"
        ]
      },
      {
        "title": "数据边界",
        "warning": true,
        "items": [
          "云仓库存与销量均以菜鸟原始导出文件及校验结果为依据，不包含其他业务账本。",
          "菜单存在不代表真实平台无人值守采集已验证；各页技术原理会列明限制。"
        ]
      }
    ],
    "sources": [
      "desktop/renderer/index.html、renderer.js、feature-help.js",
      "desktop/main.mjs、desktop/preload.cjs"
    ]
  },
  "dashboard": {
    "title": "云仓库存同步",
    "summary": "从菜鸟云仓采集库存与月度销量，校验后生成本地结果，并按设置发送库存提醒。云仓月度销量不是淘宝店铺销售额。",
    "manual": [
      {
        "title": "基本操作",
        "ordered": true,
        "items": [
          "先到公共设置保存菜鸟账号、低库存阈值及钉钉接收目标。首次登录或验证可能需要人工完成。",
          "先完成「登录 / 刷新菜鸟状态」，再按需要点击「立即同步并发送」，查看任务状态和日志；采集、校验及发送应分别确认。「刷新库存 / 刷新统计」只读已保存数据，不重新采集平台。",
          "库存明细页可筛选「全部 / 需关注 / 严重缺货」；月度销量页选择年份、排名月份、SKU 或多商品趋势。",
          "历史月份补采按页面支持的范围执行。不要把缺失月份视为零销量。"
        ]
      },
      {
        "title": "异常处理",
        "warning": true,
        "items": [
          "登录失效或页面变化时停止猜测，查看日志并重新完成登录；发送失败应核对钉钉配置。",
          "返回主页不会自动取消任务。软件未运行、休眠或断网时计划任务无法保证执行。"
        ]
      }
    ],
    "principle": [
      {
        "title": "处理链路",
        "items": [
          "界面 → inventoryApp → 主进程任务管理启动独立子进程 → Node/Playwright 采集脚本 → 导出文件和本地快照 → 校验 → 库存汇总或钉钉提醒。",
          "库存阈值、校验异常与钉钉投递是独立环节，不能用“打开页面”代替采集成功，也不能用“采集成功”代替发送成功。",
          "月度销量由云仓报表归集，按 SKU 和月份绘制趋势，统计为 toC 与 toB 件数，不是销售金额。库存先校验再入库，快照按导出文件来源日期保存。钉钉仅在有严重缺货商品时尝试发送；同步成功但跳过通知不等于发送失败。发送失败也不会撤销已入库库存。"
        ]
      },
      {
        "title": "运行边界",
        "warning": true,
        "items": [
          "程序需要有效平台会话与网络。验证码不绕过；真实平台流程是否可无人值守需在目标环境单独验收。",
          "钉钉发送属于外部操作，修改接收目标前确认范围，避免把真实库存发给错误群或人员。"
        ]
      }
    ],
    "sources": [
      "desktop/renderer/renderer.js、desktop/main.mjs",
      "core/sync-cainiao-inventory.js、core/erp/inventory-validation.js",
      "core/sync-cainiao-monthly-sales.js、core/backfill-cainiao-monthly-sales.js"
    ]
  },
  "inventory": {
    "title": "云仓库存同步 · 库存明细",
    "summary": "查看最近一次已保存的库存报告，并按需关注 / 严重缺货预警筛选。这里只查看库存，不采集店铺销售金额。",
    "manual": [
      {
        "title": "查看与核对",
        "ordered": true,
        "items": [
          "先在运行概览完成库存采集和校验，然后进入库存明细。",
          "根据需要选择「全部 / 需关注 / 严重缺货」，搜索目标商品 / SKU。",
          "核对采集时间、商品标识、库存数量和异常原因，再据此决定补货。无报告或采集失败时先回运行概览查看日志。"
        ]
      },
      {
        "title": "使用限制",
        "warning": true,
        "items": [
          "库存快照不是实时库存保证；补货前按实际业务核对。",
          "筛选只影响当前查看范围，不修改原始导出文件，不自动采购或付款。"
        ]
      }
    ],
    "principle": [
      {
        "title": "数据与筛选",
        "items": [
          "renderer.js 通过库存报告读取接口获取本地最近报告，并用表格组件显示。",
          "当前库存明细的预警筛选按可售天数分级：用库存量及近 30 天销量（缺失时取月出库量）估算；设置中的数量阈值是另一项配置，不能与本页预警混淆。界面筛选不是新的平台采集。",
          "报告保留数据时间和问题，采集失败不能用旧报告冒充本次成功。"
        ]
      },
      {
        "title": "口径边界",
        "warning": true,
        "items": [
          "库存数量、云仓发货销量和淘宝收入账单是三种数据，不可直接相加。",
          "对缺失或格式异常 SKU 应查看原文件与日志，不能凭名称猜测对应关系。"
        ]
      }
    ],
    "sources": [
      "desktop/renderer/renderer.js：loadInventory、renderInventoryGrid",
      "desktop/shared/inventory-store.mjs；core/erp/inventory-alert.js、inventory-validation.js"
    ]
  },
  "sales": {
    "title": "云仓库存同步 · 月度销量",
    "summary": "查看云仓报表形成的月度销量与 SKU 趋势。此页用于云仓销售数量分析，不等同于千牛收入账单的销售金额。",
    "manual": [
      {
        "title": "查看趋势",
        "ordered": true,
        "items": [
          "在运行概览执行月度销售采集，历史月份需要补采时按页面范围执行。",
          "进入月度销量，选择月份 / 年份及所需 SKU，切换总体、单品或多商品趋势。",
          "可调整图例显示范围；发现缺月、异常峰值或 SKU 不一致时先核对原始报表和采集记录。"
        ]
      },
      {
        "title": "常见问题",
        "warning": true,
        "items": [
          "暂无报表不表示零销量；先确认该月份是否成功采集。",
          "本页仅展示云仓商品数量，不能用数量估算店铺收入。店铺销售额应以平台原始账单核对。"
        ]
      }
    ],
    "principle": [
      {
        "title": "报表到图表",
        "items": [
          "采集脚本导出菜鸟月度销售报表，本地服务按月份和 SKU 归集。renderer.js 读取后由 ECharts 绘制趋势。",
          "图表视图、图例和 SKU 选择只是呈现过滤，不修改报表原值。",
          "历史补采与日常计划仍需软件运行和有效会话；缺月必须明确显示并补齐。"
        ]
      },
      {
        "title": "不能混用的指标",
        "warning": true,
        "items": [
          "出库 / 销售数量不是支付成交额、结算收入或不含税销售额。",
          "未确认价格、退款和时间归属时不从数量乘单价推导店铺销售额。"
        ]
      }
    ],
    "sources": [
      "desktop/renderer/renderer.js：loadMonthlySales",
      "core/sync-cainiao-monthly-sales.js、core/backfill-cainiao-monthly-sales.js",
      "desktop/shared/monthly-sales-store.mjs"
    ]
  },
  "settings": {
    "title": "公共设置",
    "summary": "管理软件运行角色、菜鸟与钉钉配置、计划和更新。保存配置可能影响任务执行位置与外部消息接收范围。",
    "manual": [
      {
        "title": "配置流程",
        "ordered": true,
        "items": [
          "先确认本机角色：单机只在本机运行；主服务器保管权威数据并执行任务；客户端连接主服务器查看和执行允许的预置任务。",
          "填写必要账号和钉钉接收目标，保存后查看配置状态；不要在截图、源码或日志中公开密码和 Secret。",
          "按需要配置库存阈值、计划和 Windows 登录自启。软件退出、休眠或断网时任务不能保证运行。",
          "诊断问题时打开日志目录或导出脱敏 Debug Bundle；核对版本与迭代历史。更新下载后由本人确认重启安装。"
        ]
      },
      {
        "title": "配置前确认",
        "warning": true,
        "items": [
          "切换角色前确认数据位置和任务执行主机，避免客户端写出本地影子账本。店铺账单采集目前请在主服务器或单机使用。",
          "改变钉钉目标、远程访问权限或计划可能影响真实业务，先核对范围再保存。"
        ]
      }
    ],
    "principle": [
      {
        "title": "配置与权限",
        "items": [
          "设置页经 preload 的配置接口调用主进程，普通设置和加密凭据分别保存；Windows 密码、Secret 和 Webhook 使用 DPAPI 保护。",
          "服务端 / 客户端通过远程服务接口同步允许的数据与任务，客户端不是独立采集主机；具体权限以实际配置为准。",
          "CLI 和本地 stdio MCP 复用同一核心，写入型 action 仍须显式授权。扩展代码需要本人信任。"
        ]
      },
      {
        "title": "运行和更新边界",
        "warning": true,
        "items": [
          "进程内计划不是关机后也会运行的 Windows 任务计划；软件与电脑需运行。",
          "正式更新使用发布配置的 Release 源；源码改动不会自动覆盖已安装版本，需要单独构建 / 安装，不应把本地测试当发布成功。"
        ]
      }
    ],
    "sources": [
      "desktop/renderer/renderer.js、desktop/main.mjs、desktop/preload.cjs",
      "desktop/shared/settings.mjs、secret-storage.mjs、remote-service.mjs",
      "desktop/shared/changelog.mjs、build/electron-builder.config.cjs"
    ]
  }
};
