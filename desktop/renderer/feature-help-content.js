window.erpFeatureHelpContent = {
  "dashboard": {
    "title": "云仓同步",
    "summary": "从菜鸟云仓采集库存与月度销量，校验后生成本地结果，并按设置发送库存提醒。云仓月度销量不是淘宝店铺销售额。",
    "manual": [
      {
        "title": "基本操作",
        "ordered": true,
        "items": [
          "先到云仓设置保存菜鸟账号、低库存阈值及钉钉接收目标。首次登录或验证可能需要人工完成。",
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
          "返回工作台不会自动取消任务。软件未运行、休眠或断网时计划任务无法保证执行。"
        ]
      }
    ],
    "principle": [
      {
        "title": "处理链路",
        "items": [
          "界面 → inventoryApp → 主进程任务管理启动独立子进程 → Node/Playwright 采集脚本 → 导出文件和本地快照 → 校验 → 库存汇总或钉钉提醒。",
          "库存阈值、校验异常与钉钉投递是独立环节，不能用“打开页面”代替采集成功，也不能用“采集成功”代替发送成功。每日完成要求当天新采集，来源日期至少达到上一业务日的最新结算日期；首页同时显示业务日与来源日期。",
          "月度销量由云仓报表归集，按 SKU 和月份绘制趋势，统计为 toC 与 toB 件数，不是销售金额。库存先校验再入库，快照按导出文件来源日期保存。每日同步发送严重缺货预警；没有严重预警时发送简短的正常摘要。首页分开核对采集、校验入库、群发送凭据；发送失败不会撤销已入库库存，发送结果未知时需要人工核对。"
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
    "title": "云仓同步 · 库存明细",
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
    "title": "云仓同步 · 月度销量",
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
    "title": "云仓设置",
    "summary": "管理菜鸟与钉钉配置、计划和更新。连接和成员权限统一在外层工作台的 Tailscale 设置中维护。",
    "manual": [
      {
        "title": "配置流程",
        "ordered": true,
        "items": [
          "连接、服务器及成员权限统一在工作台的 Tailscale 设置中管理；云仓设置仅维护业务账号、同步计划与钉钉机器人。",
          "填写必要账号和钉钉接收目标，保存后查看配置状态；不要在截图、源码或日志中公开密码和 Secret。",
          "按需要配置库存阈值、计划和 Windows 登录自启。软件退出、休眠或断网时任务不能保证运行。",
          "诊断问题时打开日志目录或导出脱敏 Debug Bundle；核对版本与迭代历史。更新下载后由本人确认重启安装。"
        ]
      },
      {
        "title": "配置前确认",
        "warning": true,
        "items": [
          "员工从自己的 Tailscale 工作台入口访问；原有旧版客户端配置需回到工作台核对连接，不能据旧配置认为已迁移完成。",
          "改变钉钉目标、远程访问权限或计划可能影响真实业务，先核对范围再保存。"
        ]
      }
    ],
    "principle": [
      {
        "title": "配置与权限",
        "items": [
          "设置页经 preload 的配置接口调用主进程，普通设置和加密凭据分别保存；Windows 密码、Secret 和 Webhook 使用 DPAPI 保护。",
          "Tailscale 工作台网关验证成员身份、权限与每次修改请求；采集在主服务器执行。云仓页不再设置运行角色或 Cloudflare 远程地址。",
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
      "desktop/shared/settings.mjs、secret-storage.mjs、desktop/workbench/gateway.mjs",
      "desktop/shared/changelog.mjs、build/electron-builder.config.cjs"
    ]
  },
  "attendance": {
    "title": "云仓同步 · 签到管理",
    "summary": "按北京时间记录员工本人签到与每日任务完成，并由管理员催办未完成的工作。",
    "manual": [
      { "title": "员工每日操作", "ordered": true, "items": ["使用自己的 Tailscale 工作台账号登录，点击运行概览中的今日签到；管理员本机不能代替员工打卡。", "核对库存并处理预警。今日最新数据完成采集、校验入库和钉钉群发送后，点击确认今日任务完成，保留本人确认时间。", "签到和任务完成分别记录；工作日、每日截止时间及任务说明由管理员安排。"] },
      { "title": "管理员设置与催办", "items": ["点击添加员工，填写与工作台成员一致的 Tailscale 登录账号、姓名、工作日和任务。此处添加员工不会授予工作台访问权限。", "配置员工的邮箱、钉钉用户 ID 或手机号，再启用相应渠道。邮件、短信和电话凭据只在主服务器本机保存。", "管理员逐人点击提醒，核对对象与渠道后确认。自动催办默认关闭，启用后仅对超过截止时间且未完成的员工执行。"] }
    ],
    "principle": [
      { "title": "身份和完成凭据", "items": ["员工签到从网关核验的 Tailscale 身份取得人员标识，不能通过选择姓名替其他员工签到；只读成员不能提交签到。", "今日任务完成绑定持久化同步批次：来源日期、原始文件摘要、校验记录、已导入快照和群发送结果须匹配；旧库存补发不能作为今日完成。", "服务器按 Asia/Shanghai 判断日期和截止时间；每名员工每日保留一条签到记录，并分别记录签到与任务完成时间。"] },
      { "title": "通知结果与运行边界", "warning": true, "items": ["每人每天每渠道最多发起一次提醒，包含失败或结果未知的记录；结果未知时先核对服务商记录，系统不会盲目重复短信或电话。", "服务商已受理表示已接受请求，不代表邮件已读、短信已到达、电话已接听或员工已完成工作。短信和电话可能产生服务费用。", "自动提醒需要主服务器持续在线。关机、休眠、软件退出或断网时无法保证按时催办。"] }
    ],
    "sources": ["core/erp/warehouse-daily.js、desktop/shared/warehouse-reminder-senders.mjs", "desktop/renderer/daily-work-ui.mjs、desktop/main.mjs", "desktop/modules/cloud-control.mjs、desktop/workbench/actor.mjs"]
  }
};
