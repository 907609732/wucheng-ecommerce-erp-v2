import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

ApplicationWindow {
    id: win
    visible: true
    width: 1220; height: 850
    minimumWidth: 1000; minimumHeight: 720
    title: v.demo_mode ? "电商自动开票助手 · 模拟演示（非真实开票）" : "电商自动开票助手 · 2.0"
    color: "#F3F5F9"
    font.family: "Microsoft YaHei UI"
    font.pixelSize: 14
    property var v: backend.view
    property int page: 0
    property string mode: "platform"
    property var selected: []
    property string activeAccount: ""
    property var editIssue: ({})
    property string templateTarget: "zhejiang"
    property var mappingEdits: ({})
    property string mappingRole: "request"
    function showLoginDialog() { accountDialog.open() }
    property int flowStep: v.seller_confirmed ? (v.current ? 2 : 1) : 0
    property var stepNames: ["首次设置", "获取数据", "检查资料", "准备文件", "登记归档"]
    property var stepHints: ["第一次使用：确认销售方 → 添加并登录店铺 → 确认模板。以后通常从第 2 步开始。", "勾选店铺和输出格式，再点击获取。遇到扫码或验证码，请在浏览器中完成。", "先逐项补资料、核对金额及是否已开票，再审核合格申请。异常申请不会被强行放行。", "准备文件 → 打开文件核对 → 按说明导入新福通或税务局。实际开具在目标系统完成。", "只有实际开具成功后，才导入发票号码，再归档发票附件。文件生成不代表已经开票。"]
    component Primary: Button {
        font.bold: true
        padding: 13
        background: Rectangle { color: parent.enabled ? (parent.down ? "#174AB6" : "#2563EB") : "#CAD3E4"; radius: 8 }
        contentItem: Text { text: parent.text; color: "white"; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font: parent.font }
    }
    component Card: Rectangle { color: "white"; radius: 12; border.color: "#E5EAF1" }
    component Muted: Label { color: "#69788E"; wrapMode: Text.WordWrap }
    component Field: TextField { padding: 10; selectByMouse: true; Layout.fillWidth: true }
    component Section: Label { font.pixelSize: 19; font.bold: true; color: "#172B4D" }

    RowLayout {
        anchors.fill: parent; spacing: 0
        Rectangle {
            Layout.fillHeight: true; Layout.preferredWidth: 202; color: "#FFFFFF"
            ColumnLayout {
                anchors.fill: parent; anchors.margins: 22; spacing: 14
                Label { text: "开票助手"; font.pixelSize: 25; font.bold: true; color: "#1C3F7A"; Layout.topMargin: 16 }
                Muted { text: "申请整理 · 一键准备"; font.pixelSize: 12; Layout.bottomMargin: 28 }
                Repeater {
                    model: ["开始开票", "历史记录", "资料设置"]
                    delegate: Button {
                        required property string modelData
                        required property int index
                        text: modelData; Layout.fillWidth: true; implicitHeight: 46
                        background: Rectangle { radius: 8; color: win.page === index ? "#EAF1FF" : "transparent" }
                        contentItem: Text { text: parent.text; color: win.page === index ? "#2563EB" : "#53647D"; verticalAlignment: Text.AlignVCenter; font.bold: win.page === index; leftPadding: 13 }
                        onClicked: win.page = index
                    }
                }
                Item { Layout.fillHeight: true }
                Muted { text: "文件准备完成 ≠ 已开票\n实际开具请在目标系统确认"; font.pixelSize: 11; lineHeight: 1.5 }
                Label { text: "本地保存 · 2.0"; color: "#9AA6B7"; font.pixelSize: 11 }
            }
        }
        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.margins: 28; spacing: 18
            RowLayout {
                Layout.fillWidth: true
                ColumnLayout {
                    Label { text: ["按步骤开票", "历史记录", "首次设置与维护"][win.page]; font.pixelSize: 28; font.bold: true; color: "#172B4D" }
                    Muted { text: ["从左往右操作，每次只处理当前这一步。", "选择历史批次可继续检查、准备文件或登记结果。", "按 1 → 2 → 3 设置，完成后返回开票流程。"][win.page] }
                }
                Item { Layout.fillWidth: true }
                Label { text: v.busy ? "● 任务进行中" : "● 本地工作台"; color: v.busy ? "#2563EB" : "#628273" }
            }
            Card {
                Layout.fillWidth: true; implicitHeight: msg.implicitHeight + 28
                color: "#EDF3FF"; border.color: "#DCE8FD"
                Label { id: msg; anchors.fill: parent; anchors.margins: 14; text: v.message; wrapMode: Text.WordWrap; color: "#31527E" }
            }
            StackLayout {
                currentIndex: win.page; Layout.fillWidth: true; Layout.fillHeight: true
                ScrollView {
                    clip: true; contentWidth: availableWidth
                    ColumnLayout {
                        width: parent.width; spacing: 18
                        RowLayout {
                            Layout.fillWidth: true; spacing: 6
                            Repeater {
                                model: win.stepNames
                                delegate: Button {
                                    required property string modelData
                                    required property int index
                                    Layout.fillWidth: true; implicitHeight: 48
                                    text: (index+1)+"  "+modelData
                                    background: Rectangle { radius: 8; color: win.flowStep===index ? "#2563EB" : "#E8EDF5" }
                                    contentItem: Text { text: parent.text; font: parent.font; color: win.flowStep===index ? "white" : "#53647D"; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                                    onClicked: win.flowStep=index
                                }
                            }
                        }
                        Card {
                            Layout.fillWidth: true; implicitHeight: guide.implicitHeight+36
                            color: "#EDF3FF"
                            ColumnLayout {
                                id: guide; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 18; spacing: 10
                                Section { text: "第 "+(win.flowStep+1)+" 步 · "+win.stepNames[win.flowStep] }
                                Muted { text: win.stepHints[win.flowStep]; Layout.fillWidth: true }
                                Primary { visible: win.flowStep===0; text: "去完成首次设置"; onClicked: win.page=2 }
                                Muted { visible: win.flowStep===0; text: v.seller_confirmed ? "销售方资料已确认；请继续检查店铺和模板。" : "销售方资料尚未确认，请先设置。"; Layout.fillWidth: true }
                                Muted { visible: win.flowStep>=2 && !v.current; text: "尚无批次，请返回第 2 步获取数据。"; Layout.fillWidth: true }
                            }
                        }
                        RowLayout {
                            visible: false
                            Layout.fillWidth: true; spacing: 16
                            Repeater {
                                model: [{key:"jushuitan",title:"聚水潭 ERP · 已暂停",sub:"申请记录不能证明尚未开票",tag:"模式一"}, {key:"platform",title:"电商平台",sub:"淘宝天猫优先接入 · 拼多多 · 京东",tag:"模式二"}]
                                delegate: Card {
                                    required property var modelData
                                    Layout.fillWidth: true; implicitHeight: 134
                                    border.color: win.mode === modelData.key ? "#2563EB" : "#E5EAF1"; border.width: win.mode === modelData.key ? 2 : 1
                                    ColumnLayout {
                                        anchors.fill: parent; anchors.margins: 22; spacing: 7
                                        Label { text: modelData.tag + (win.mode === modelData.key ? "   ✓ 已选择" : ""); color: "#2563EB"; font.pixelSize: 12 }
                                        Section { text: modelData.title }
                                        Muted { text: modelData.sub }
                                    }
                                    MouseArea { anchors.fill: parent; enabled: !v.busy && modelData.key!=="jushuitan"; cursorShape: Qt.PointingHandCursor; onClicked: { win.mode=modelData.key; win.selected=[] } }
                                }
                            }
                        }
                        Card {
                            visible: win.flowStep===1
                            Layout.fillWidth: true; implicitHeight: setup.implicitHeight+40
                            ColumnLayout {
                                id: setup; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 20; spacing: 12
                                RowLayout { Section { text: "① 选择店铺" } Item { Layout.fillWidth: true } Button { text: "添加 / 登录店铺"; onClicked: win.page=2 } }
                                Repeater {
                                    model: v.accounts
                                    delegate: CheckBox {
                                        required property var modelData
                                        visible: (modelData.platform === "jushuitan") === (win.mode === "jushuitan")
                                        Layout.fillWidth: true
                                        text: modelData.name + "   ·   " + modelData.label + "   ·   " + modelData.state_label
                                        checked: win.selected.indexOf(modelData.id)>=0
                                        enabled: !v.busy
                                        onToggled: { var a=win.selected.slice(); if(checked) { if(a.indexOf(modelData.id)<0)a.push(modelData.id) } else a=a.filter(x=>x!==modelData.id); win.selected=a }
                                    }
                                }
                                Muted { visible: v.accounts.length===0; text: "还没有连接账号。先到「资料设置」添加并登录公司/店铺。" }
                                Rectangle { Layout.fillWidth: true; height: 1; color: "#EEF1F5" }
                                RowLayout {
                                    Label { text: "② 选择输出格式"; color: "#43536A" }
                                    CheckBox { id: xft; text: "新福通"; checked: v.targets.indexOf("xinfutong")>=0; enabled: !v.busy }
                                    CheckBox { id: zj; text: "浙江税务局"; checked: v.targets.indexOf("zhejiang")>=0; enabled: !v.busy }
                                    Item { Layout.fillWidth: true }
                                }
                                Muted { text: "仅处理平台明确待开票的申请；空状态、待审核、退款和已开票记录不会自动放行。淘宝“待录入”还需核对已开未回传记录。"; font.pixelSize: 12; Layout.fillWidth: true }
                                Primary { text: v.busy ? "正在处理 · " + v.stage : "③ 获取待开票数据"; Layout.fillWidth: true; enabled: !v.busy && v.seller_confirmed && win.selected.length>0 && (xft.checked || zj.checked); onClicked: { var t=[]; if(xft.checked)t.push("xinfutong"); if(zj.checked)t.push("zhejiang"); backend.start(win.mode,win.selected,t) } }
                                Muted { visible: !v.seller_confirmed || win.selected.length===0; text: !v.seller_confirmed ? "先完成第 1 步：确认销售方资料。" : "请先勾选至少一家店铺。"; Layout.fillWidth: true }
                                Muted { text: "当前使用模式二：电商平台。聚水潭申请记录无法证明尚未开票，模式一仍暂停；后台自动采集需真实验收。"; Layout.fillWidth: true; font.pixelSize: 12 }
                                Button { visible: !!v.current; text: "已有批次：去第 3 步检查 →"; enabled: !v.busy; onClicked: win.flowStep=2 }
                                RowLayout {
                                    visible: v.busy
                                    Label { text: "连接后台  →  获取申请  →  整理订单  →  准备文件"; color: "#53647D"; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                                    Button { text: "继续/关闭浏览器"; onClicked: backend.continueBrowser() }
                                    Button { text: "取消"; onClicked: backend.cancel() }
                                }
                            }
                        }
                        Card {
                            visible: v.current!=="" && (win.flowStep===2 || win.flowStep===3); Layout.fillWidth: true; implicitHeight: result.implicitHeight+40
                            ColumnLayout {
                                id: result; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 20; spacing: 12
                                RowLayout { Section { text: v.demo_mode ? "模拟批次 · 不会真实开票" : "当前批次" } Label { text: v.batch_state; color: "#B7791F" } Item { Layout.fillWidth: true } Button { visible: win.flowStep===2; text: "采集失败？重试未完成店铺"; enabled: !v.busy; onClicked: backend.retry() } }
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 36
                                    Label { text: (v.summary.request_count || 0)+" 份申请"; font.pixelSize: 18; color: "#172B4D" }
                                    Label { text: (v.summary.invoice_count || 0)+" 张预计发票"; font.pixelSize: 18; color: "#172B4D" }
                                    Label { text: "¥ "+(v.summary.amount || "0.00"); font.pixelSize: 18; color: "#172B4D" }
                                    Label { text: (v.summary.problem_count || 0)+" 份待处理"; color: "#B7791F" }
                                }
                                Repeater { model: v.scope; delegate: Muted { required property var modelData; text: modelData.text; Layout.fillWidth: true; font.pixelSize: 12 } }
                                Muted { visible: v.scope.length===0; text: v.summary.scope || "未执行真实后台全量采集"; font.pixelSize: 12 }
                                Repeater {
                                    model: v.files
                                    delegate: RowLayout {
                                        required property var modelData
                                        visible: win.flowStep===3
                                        Layout.fillWidth: true
                                        Label { text: (modelData.target==="xinfutong"?"新福通":"浙江税务局")+" · 文件已生成"; color: "#31527E"; Layout.fillWidth: true }
                                        Muted { text: "真实试导入待验收"; font.pixelSize: 12 }
                                        Button { text: "打开开票文件"; onClicked: backend.openFile(modelData.path) }
                                    }
                                }
                                Repeater { model: v.summary.export_errors || []; delegate: Muted { required property var modelData; visible: win.flowStep===3; text: "未生成："+modelData.message; color: "#B7791F"; Layout.fillWidth: true } }
                                Repeater {
                                    model: v.issues
                                    delegate: Rectangle {
                                        required property var modelData
                                        visible: win.flowStep===2
                                        Layout.fillWidth: true; implicitHeight: issueRow.implicitHeight+24; color: "#FFF9ED"; radius: 8
                                        RowLayout {
                                            id: issueRow; anchors.fill: parent; anchors.margins: 12
                                            ColumnLayout {
                                                Layout.fillWidth: true
                                                Label { text: modelData.title + (modelData.product ? " · "+modelData.product : ""); color: "#6B4C1F"; font.bold: true; elide: Text.ElideRight; Layout.fillWidth: true }
                                                Muted { text: modelData.message; color: "#8D6C37"; Layout.fillWidth: true }
                                                Muted { text: "订单 "+modelData.order+" · 来源 "+modelData.source; font.pixelSize: 11; Layout.fillWidth: true }
                                            }
                                            Button { text: ["title","tax_no","tax_code"].indexOf(modelData.code)>=0 ? "补资料" : "查看核对"; onClicked: { win.editIssue=modelData; fixValue.text=""; fixDialog.open() } }
                                        }
                                    }
                                }
                                RowLayout {
                                    Primary { visible: win.flowStep===2; text: "确认并审核合格申请"; enabled: !v.busy && (v.summary.ready_count || 0)>0; onClicked: reviewDialog.open() }
                                    Primary { visible: win.flowStep===3; text: v.files.length ? "更新本批次文件" : "生成开票文件"; enabled: !v.busy; onClicked: backend.generate() }
                                    Button { visible: win.flowStep===3; text: "查看目标系统导入说明"; onClicked: helpDialog.open() }
                                    Item { Layout.fillWidth: true }
                                }
                            }
                        }
                        Card {
                            visible: win.flowStep===4; Layout.fillWidth: true; implicitHeight: registerPanel.implicitHeight+40
                            ColumnLayout {
                                id: registerPanel; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 20; spacing: 14
                                Section { text: "实际开具后，再完成以下操作" }
                                Muted { text: "① 导入结果：Excel 需包含「单据号」和「发票号码」。拆票按每张登记，未成功部分保留。\n② 归档附件：选择已登记的单据，保存对应发票文件。"; Layout.fillWidth: true }
                                Primary { text: "① 登记实际开票结果"; enabled: !v.busy && !!v.current; onClicked: resultFiles.open() }
                                Button { text: "② 归档发票附件"; enabled: !v.busy && (v.summary.issued_count || 0)>0; onClicked: archiveDialog.open() }
                                Muted { text: "当前批次已登记开票成功："+(v.summary.issued_count || 0)+" 份申请。模拟结果不计入真实开票。"; Layout.fillWidth: true }
                                Button { text: "查看历史记录"; onClicked: win.page=1 }
                            }
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            Button { text: "← 上一步"; enabled: win.flowStep>0 && !v.busy; onClicked: win.flowStep-- }
                            Item { Layout.fillWidth: true }
                            Primary { text: win.flowStep===3 ? "已在目标系统开具？去登记 →" : "下一步："+win.stepNames[Math.min(win.flowStep+1,4)]+" →"; visible: win.flowStep<4; enabled: !v.busy && (win.flowStep===0 ? v.seller_confirmed : win.flowStep===1 ? !!v.current : win.flowStep===3 ? v.files.length>0 : !!v.current); onClicked: win.flowStep++ }
                        }
                        Muted { text: "实际提交开具、回写平台和发送发票不在本期自动操作范围内。"; font.pixelSize: 12; Layout.bottomMargin: 12 }
                    }
                }
                ScrollView {
                    clip: true; contentWidth: availableWidth
                    ColumnLayout {
                        width: parent.width; spacing: 14
                        RowLayout { Button { text: "返回当前批次流程"; onClicked: { win.page=0; win.flowStep=2 } } Button { text: "备份数据"; onClicked: backend.backup() } Item { Layout.fillWidth: true } }
                        CheckBox { id: showSimulation; text: "展开高级工具：模拟执行测试（非日常开票步骤）" }
                        Card {
                            visible: showSimulation.checked
                            Layout.fillWidth: true; implicitHeight: queuePanel.implicitHeight+36
                            ColumnLayout {
                                id: queuePanel; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 18; spacing: 10
                                Section { text: "开票执行队列 · 正式提交已锁定" }
                                Muted { text: "先选下方批次，再建立模拟任务。模拟只验证流程，不会调用开票软件或登记真实发票。未知状态不能直接恢复或重试。"; Layout.fillWidth: true }
                                RowLayout {
                                    Button { text: "当前批次建立模拟任务"; enabled: !v.busy; onClicked: backend.enqueueMock() }
                                    Primary { text: "运行模拟队列"; enabled: !v.busy && !v.queue_paused; onClicked: backend.runMockQueue() }
                                    Button { text: v.queue_paused ? "恢复队列" : "暂停队列"; onClicked: backend.toggleQueue() }
                                }
                                Repeater {
                                    model: v.execution_tasks
                                    delegate: ColumnLayout {
                                        required property var modelData
                                        Layout.fillWidth: true; spacing: 5
                                        Label { text: modelData.invoice_id+" · "+modelData.provider+" · "+modelData.label; color: modelData.state==="unknown"?"#B45309":"#31527E"; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                                        Muted { text: modelData.message || "尚未执行"; font.pixelSize: 12; Layout.fillWidth: true }
                                        RowLayout {
                                            Button { text: "暂停"; visible: modelData.state==="queued"; enabled: !v.busy; onClicked: backend.taskAction(modelData.id,"pause") }
                                            Button { text: "恢复"; visible: ["paused","not_submitted"].indexOf(modelData.state)>=0; enabled: !v.busy; onClicked: backend.taskAction(modelData.id,"resume") }
                                            Button { text: "取消未提交任务"; visible: ["queued","paused","not_submitted","failed_preflight"].indexOf(modelData.state)>=0; enabled: !v.busy; onClicked: backend.taskAction(modelData.id,"cancel") }
                                            Button { text: "先核对原提交结果"; visible: ["unknown","awaiting_human"].indexOf(modelData.state)>=0; enabled: !v.busy; onClicked: backend.taskAction(modelData.id,"reconcile") }
                                        }
                                    }
                                }
                                Button { text: "打开本地执行归档"; onClicked: backend.openFile(v.data_dir+"/归档") }
                            }
                        }
                        Muted { text: "结果文件需包含「单据号」和「发票号码」。拆票按每个单据登记，未成功部分不会被标成已开完。"; Layout.fillWidth: true }
                        Repeater {
                            model: v.history
                            delegate: Card {
                                required property var modelData
                                Layout.fillWidth: true; implicitHeight: 104
                                RowLayout {
                                    anchors.fill: parent; anchors.margins: 20
                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        Section { text: modelData.date + "  ·  " + (modelData.mode==="mock_demo"?"模拟演示（非真实）":modelData.mode==="jushuitan"?"聚水潭":modelData.mode==="recovery"?"人工恢复":"电商平台") }
                                        Muted { text: modelData.state_label + "   |   " +(modelData.summary.request_count || 0)+" 份申请   |   ¥ "+(modelData.summary.amount || "0") }
                                        Muted { text: "批次 "+modelData.id; font.pixelSize: 11 }
                                    }
                                    Button { text: "查看 / 继续该批次"; enabled: !v.busy; onClicked: { backend.selectBatch(modelData.id); win.page=0; win.flowStep=2 } }
                                }
                            }
                        }
                        Muted { visible: v.history.length===0; text: "还没有历史批次。开始一次采集后会在这里保留记录。" }
                    }
                }
                ScrollView {
                    clip: true; contentWidth: availableWidth
                    ColumnLayout {
                        width: parent.width; spacing: 18
                        Card {
                            Layout.fillWidth: true; implicitHeight: sellerForm.implicitHeight+40
                            ColumnLayout {
                                id: sellerForm; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 20; spacing: 10
                                Section { text: "1. 确认销售方资料" }
                                Muted { text: v.seller_confirmed ? "已确认 · 修改资料会重新检查尚未开票的申请" : "首次使用请确认旧版保留的销售方与税率，不从样例推断。" }
                                Field { id: sellerName; placeholderText: "销售方名称"; text: v.seller.name || "" }
                                RowLayout { Layout.fillWidth: true; Field { id: sellerTax; placeholderText: "销售方税号"; text: v.seller.tax_no || "" } Field { id: sellerRate; placeholderText: "税率，如 0.01"; text: v.rate; Layout.maximumWidth: 160 } }
                                Primary { text: "确认并保存销售方资料"; enabled: !v.busy; onClicked: backend.saveSeller(sellerName.text,sellerTax.text,sellerRate.text) }
                            }
                        }
                        Card {
                            Layout.fillWidth: true; implicitHeight: accountForm.implicitHeight+40
                            ColumnLayout {
                                id: accountForm; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 20; spacing: 12
                                RowLayout { Section { text: "2. 登录平台，自动识别店铺" } Item { Layout.fillWidth: true } Primary { text: "登录并识别店铺"; enabled: !v.busy; onClicked: accountDialog.open() } }
                                Muted { text: "只选平台，无需填写名称和ID。扫码登录后打开店铺信息页，程序读取明确标注的名称与ID；读不全或发现跨店时停止，不猜填。独立 Chrome 保留登录状态，不复制日常浏览器密码。身份识别不代表订单采集已验收。"; Layout.fillWidth: true }
                                RowLayout {
                                    visible: v.busy; Layout.fillWidth: true
                                    Muted { text: "正在连接 / 识别店铺，请在浏览器完成登录。"; Layout.fillWidth: true }
                                    Button { text: "取消本次连接"; onClicked: backend.cancel() }
                                }
                                Repeater {
                                    model: v.accounts
                                    delegate: RowLayout {
                                        required property var modelData
                                        Layout.fillWidth: true
                                        ColumnLayout { Layout.fillWidth: true; Label { text: modelData.name+" · "+modelData.label } Muted { text: (modelData.shop_id ? "店铺 ID："+modelData.shop_id : "尚未识别店铺 ID")+" · "+modelData.state_label; font.pixelSize: 12 } }
                                        Primary { text: modelData.shop_id ? "重新连接 / 核对身份" : "登录并自动识别"; enabled: !v.busy && modelData.platform!=="jushuitan"; onClicked: backend.connectAccount(modelData.id) }
                                        Button {
                                            text: "更多设置 ▾"; enabled: !v.busy
                                            onClicked: accountMore.open()
                                            Menu {
                                                id: accountMore
                                                MenuItem { text: "查看识别身份 / 导出路径（高级）"; onTriggered: { win.activeAccount=modelData.id; var b=JSON.parse(modelData.binding); bindIdentity.text=b.identity_text || ""; bindCompany.text=modelData.company; bindShop.text=modelData.shop_id; bindRecipe.text=b.recipe ? JSON.stringify(b.recipe,null,2) : ""; bindDialog.open() } }
                                                MenuItem { text: "字段映射（高级）"; onTriggered: { win.activeAccount=modelData.id; mappingChoose.open() } }
                                                MenuItem { text: "采集故障时手动导入"; enabled: modelData.platform!=="jushuitan"; onTriggered: { win.activeAccount=modelData.id; recoveryFiles.open() } }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Card {
                            Layout.fillWidth: true; implicitHeight: templateForm.implicitHeight+40
                            ColumnLayout {
                                id: templateForm; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 20; spacing: 10
                                Section { text: "3. 确认官方开票模板" }
                                Muted { text: "新福通复用现有官方模板。浙江税务局需从实际后台下载；不识别的结构会停止输出。文件生成仍需真实小批量试导入验收。"; Layout.fillWidth: true }
                                Repeater { model: v.templates; delegate: Muted { required property var modelData; text: (modelData.target==="xinfutong"?"新福通":"浙江税务局")+" · 已登记结构版本 "+modelData.signature.slice(0,10)+" · 试导入未验收" } }
                                RowLayout {
                                    Button { text: "更新新福通模板"; onClicked: { win.templateTarget="xinfutong"; templateFiles.open() } }
                                    Button { text: "导入浙江税务局模板"; onClicked: { win.templateTarget="zhejiang"; templateFiles.open() } }
                                }
                            }
                        }
                        Primary { text: "设置完成，去获取数据 →"; enabled: v.seller_confirmed && !v.busy; onClicked: { win.page=0; win.flowStep=1 } }
                        Muted { text: "运行数据："+v.data_dir; Layout.fillWidth: true; font.pixelSize: 11; Layout.bottomMargin: 20 }
                    }
                }
            }
        }
    }
    Dialog {
        id: accountDialog; title: "选择平台，登录后自动识别店铺"; modal: true; anchors.centerIn: parent; width: 550
        ColumnLayout {
            anchors.fill: parent; spacing: 10
            ComboBox { id: platform; Layout.fillWidth: true; model: ["淘宝天猫","拼多多","京东"] }
            Muted { text: "1. 点击下方按钮打开专用浏览器。\n2. 你完成扫码 / 验证码登录。\n3. 打开店铺信息页，助手自动读取名称和ID并保存。\n\n读取不完整时会提示重试，不需要猜填信息。销售方开票资料仍需你单独确认，不从店铺名称推断。"; Layout.fillWidth: true }
            Primary { text: "打开浏览器，登录并识别"; Layout.fillWidth: true; enabled: !v.busy; onClicked: { accountDialog.close(); backend.loginPlatform(["taobao","pinduoduo","jd"][platform.currentIndex]) } }
            Button { text: "暂不连接"; onClicked: accountDialog.close() }
        }
    }
    Dialog {
        id: bindDialog; title: "已识别身份与正式导出路径"; modal: true; anchors.centerIn: parent; width: 640; height: 510
        standardButtons: Dialog.Save | Dialog.Cancel
        ColumnLayout {
            anchors.fill: parent
            Field { id: bindIdentity; readOnly: true; placeholderText: "名称由登录后自动识别" }
            Field { id: bindCompany; readOnly: true; placeholderText: "数据隔离标识（非开票主体）" }
            Field { id: bindShop; readOnly: true; placeholderText: "店铺ID由登录后自动识别" }
            Muted { text: "高级接入：路径必须由真实页面验证后配置；筛选范围和总数不能推测。当前版本不预置未实测的后台选择器。"; Layout.fillWidth: true }
            ScrollView { Layout.fillWidth: true; Layout.fillHeight: true; TextArea { id: bindRecipe; placeholderText: '{"pending_marker":"待开票","scope_marker":"实际查询范围文字","count_pattern":"共\\\\s*(\\\\d+)\\\\s*条","request_export":"导出全部申请","detail_export":"导出全部明细"}'; wrapMode: TextEdit.Wrap; selectByMouse: true } }
        }
        onAccepted: backend.updateBinding(win.activeAccount,bindIdentity.text,bindRecipe.text,bindCompany.text,bindShop.text)
    }
    Dialog {
        id: fixDialog; title: "补充与核对"; modal: true; anchors.centerIn: parent; width: 580
        standardButtons: Dialog.Save | Dialog.Cancel
        ColumnLayout {
            anchors.fill: parent; spacing: 12
            Label { text: win.editIssue.title || ""; font.bold: true }
            Muted { text: win.editIssue.message || ""; Layout.fillWidth: true }
            Muted { text: "申请金额："+(win.editIssue.amount || "")+"    明细合计："+(win.editIssue.total || ""); Layout.fillWidth: true }
            Muted { text: "原始来源："+(win.editIssue.source || "")+"\n订单："+(win.editIssue.order || ""); Layout.fillWidth: true }
            Field { id: fixValue; visible: ["title","tax_no","tax_code"].indexOf(win.editIssue.code)>=0; placeholderText: win.editIssue.code==="tax_code"?"确认后的19位税收分类编码（同SKU集中复用）":"填写正确资料" }
            CheckBox { id: notIssued; visible: win.editIssue.code==="external_invoice_check"; text: "我已核对新福通、税务局及线下记录，本份申请尚未开票"; checked: false }
            Muted { text: "金额冲突、身份和完整性问题不能在这里改金额绕过检查，请核对原后台并重试采集。"; Layout.fillWidth: true }
        }
        onOpened: notIssued.checked=false
        onAccepted: { if(win.editIssue.code==="external_invoice_check" && notIssued.checked)backend.confirmNotIssued(win.editIssue.rid); else if(["title","tax_no","tax_code"].indexOf(win.editIssue.code)>=0)backend.correct(win.editIssue.rid,win.editIssue.code==="tax_code"?win.editIssue.item:-1,win.editIssue.code,fixValue.text) }
    }
    Dialog {
        id: helpDialog; title: "如何导入开票文件"; modal: true; anchors.centerIn: parent; width: 590; standardButtons: Dialog.Close
        contentItem: Label { text: "1. 先核对抬头、税号、金额、发票类型和商品编码。\n\n2. 新福通：在开票申请单的导入入口选择本批次文件。\n\n3. 浙江税务局：在与你下载模板对应的批量开票入口上传，先做少量试导入。\n\n4. 目标系统校验通过后，由你确认实际开具。\n\n5. 将含单据号和发票号码的结果表导回历史记录。\n\n本软件不自动提交开具，也不自动把平台改成已开票。"; wrapMode: Text.WordWrap; color: "#43536A" }
    }
    FileDialog { id: templateFiles; title: "选择实际后台下载的官方模板"; nameFilters: ["Excel 模板 (*.xlsx)"]; onAccepted: backend.importTemplate(win.templateTarget,selectedFile.toString()) }
    FileDialog { id: recoveryFiles; title: "故障恢复：同时选择申请表与关联明细表"; fileMode: FileDialog.OpenFiles; nameFilters: ["表格 (*.xlsx *.xls *.csv)"]; onAccepted: backend.recover(win.activeAccount,selectedFiles.map(x=>x.toString())) }
    FileDialog { id: resultFiles; title: "导入实际开票结果（单据号、发票号码）"; nameFilters: ["Excel (*.xlsx)"]; onAccepted: backend.importResults(selectedFile.toString()) }
    Dialog {
        id: archiveDialog; title: "为已登记真实发票归档附件"; modal: true; anchors.centerIn: parent; width: 530
        standardButtons: Dialog.Ok | Dialog.Cancel
        ColumnLayout {
            anchors.fill: parent; spacing: 12
            Field { id: archiveBill; placeholderText: "已登记发票的开票单单据号" }
            Muted { text: "下一步选择 PDF/OFD/XML/图片。附件按内容指纹保存，不覆盖原文件；归档不代表自动验真。"; Layout.fillWidth: true }
        }
        onAccepted: archiveFiles.open()
    }
    FileDialog { id: archiveFiles; title: "选择发票附件"; nameFilters: ["发票附件 (*.pdf *.ofd *.xml *.png *.jpg *.jpeg)"]; onAccepted: backend.archiveInvoice(archiveBill.text,selectedFile.toString()) }
    Dialog {
        id: reviewDialog; title: "批量审核当前合格申请"; modal: true; anchors.centerIn: parent; width: 500
        standardButtons: Dialog.Ok | Dialog.Cancel
        contentItem: Label { text: "请先核对本批次抬头、税号、商品、税率与金额。确认后仅登记当前版本审核；异常申请不放行，正式自动提交仍锁定。"; wrapMode: Text.WordWrap }
        onAccepted: backend.approveBatch()
    }
    Dialog {
        id: mappingChoose; title: "选择映射文件类型"; modal: true; anchors.centerIn: parent; width: 420
        standardButtons: Dialog.Ok | Dialog.Cancel
        contentItem: ComboBox { id: mappingKind; model: ["开票申请文件","订单商品明细文件"] }
        onAccepted: { win.mappingRole=mappingKind.currentIndex===0?"request":"detail"; mappingFiles.open() }
    }
    FileDialog {
        id: mappingFiles; title: "选择一份导出文件预览表头（不导入数据）"; nameFilters: ["表格 (*.xlsx *.xls *.csv)"]
        onAccepted: { backend.previewMapping(win.activeAccount,selectedFile.toString(),win.mappingRole); win.mappingEdits=v.mapping_preview.overrides || {}; if(v.mapping_preview.headers.length>0)mappingDialog.open() }
    }
    Dialog {
        id: mappingDialog; title: "字段对应关系 · 不修改原文件"; modal: true; anchors.centerIn: parent; width: 650; height: 600
        standardButtons: Dialog.Save | Dialog.Cancel
        contentItem: ScrollView {
            clip: true; contentWidth: availableWidth
            ColumnLayout {
                width: parent.width; spacing: 8
                Muted { text: "仅覆盖有变化的字段，其他保持自动识别。保存后需重新采集/恢复，不改写历史数据。"; Layout.fillWidth: true }
                Repeater {
                    model: v.mapping_preview.fields
                    delegate: RowLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        Label { text: modelData.label; Layout.preferredWidth: 180 }
                        ComboBox {
                            Layout.fillWidth: true; model: ["自动识别"].concat(v.mapping_preview.headers)
                            currentIndex: win.mappingEdits[modelData.key] ? v.mapping_preview.headers.indexOf(win.mappingEdits[modelData.key])+1 : 0
                            onActivated: { var edits=Object.assign({},win.mappingEdits); if(currentIndex===0)delete edits[modelData.key]; else edits[modelData.key]=v.mapping_preview.headers[currentIndex-1]; win.mappingEdits=edits }
                        }
                    }
                }
            }
        }
        onAccepted: backend.saveMapping(JSON.stringify(win.mappingEdits))
    }
}
