/**
 * 本地「千牛收支账单」仿真服务，仅用于开发验证。
 *
 * 它模拟的是页面行为，不是平台实现：真实按钮文案、真实分类命名、真实导出方式都必须以
 * 线上页面为准，未接通的部分在取账记录里明确标注。这里只用来验证本项目的取账流程是否
 * 正确（登录墙、店铺核对、账期设置、分类切换、同步下载、异步导出中心、分片批次、防重复）。
 */
import http from 'node:http';
import ExcelJS from 'exceljs';

export const SUBTYPES = { income: ['月汇总', '日汇总', '收入明细'], expense: ['月汇总', '日汇总'], tax: ['月汇总'] };
const KIND_LABELS = { income: '收入账单', expense: '支出账单', tax: '涉税信息报送账单' };

/** 生成一个真实的 xlsx（含表头与两行数据），用于校验下载与解析链路。 */
export async function buildBillBuffer({ sheetName = '账单', subtype = '全部', kind = 'income', amount = 100 } = {}) {
  const workbook = new ExcelJS.Workbook();
  // 固定文档时间戳，保证同一逻辑导出每次生成完全相同的字节（真实平台重复导出同批数据也应是同一份文件）。
  workbook.created = new Date('2026-09-01T00:00:00Z');
  workbook.modified = new Date('2026-09-01T00:00:00Z');
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(['日期', '收入总额', '退款金额', '收入净额', '支出金额']);
  sheet.addRow(['2026-09', amount, 10, amount - 10, kind === 'expense' ? 3 : 0]);
  sheet.addRow(['2026-09', amount + 5, 5, amount, kind === 'expense' ? 4 : 0]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const billPage = ({ account, kind, month }) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>收支账单 - 千牛财务</title>
<style>body{font:14px/1.6 system-ui;margin:0;padding:24px}
.layout{display:flex}
.side-menu{width:200px;flex:0 0 200px}
.side-menu .menu-item{display:block;padding:6px 10px;color:#333;text-decoration:none}
.panel{flex:1;padding-left:24px}
.bill-tabs{display:flex;gap:12px;margin:16px 0}.bill-tabs button,.segment-item,#query,#exportPdf,#exportExcel{padding:8px 14px;cursor:pointer}
.segment{display:flex;gap:10px;margin:12px 0}.segment-item[data-active="1"]{outline:2px solid #286be5}
.wn-date-picker2-input-range{display:inline-flex;gap:6px;margin-left:8px}
.wn-date-picker2-input-range input{width:92px;padding:6px 8px}
.notice-layer{position:fixed;left:280px;top:90px;width:420px;background:#fff;border:1px solid #ddd;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:16px;z-index:9}
table{border-collapse:collapse;margin-top:12px}td,th{border:1px solid #ccc;padding:6px 10px}</style></head>
<body>
<div class="notice-layer" id="noticeLayer"><p>收支账单更新了～ 拆分为：收入账单（积分类服务费）、支出账单两个页面</p><button class="close" id="noticeClose">关闭</button></div>
<div class="layout">
<nav class="side-menu" id="sideMenu">
  <a class="menu-item" href="/bill?side=overview">总览</a>
  <a class="menu-item" href="/bill?side=fund">资金管理</a>
  <a class="menu-item" href="/bill?side=reconcile">对账管理</a>
  <a class="menu-item" href="/bill?side=account">账户明细</a>
  <a class="menu-item" href="/bill?side=summary">收支账单</a>
  <a class="menu-item" href="/bill?side=proof">对账凭据</a>
  <a class="menu-item" href="/bill?side=invoice">发票管理</a>
  <a class="menu-item" href="/bill?side=apply">申请发票</a>
  <a class="menu-item" href="/bill?side=plat">给平台开票</a>
  <a class="menu-item" href="/bill?side=buyer">给买家开票</a>
  <a class="menu-item" href="/bill?side=base">基础信息</a>
  <a class="menu-item" href="/bill?side=deposit">保证金</a>
</nav>
<div class="panel">
<header><span id="shopAccount">店铺账号 ${escapeHtml(account)}</span></header>
<nav class="bill-tabs" id="billTabs" role="tablist">
  <button role="tab" class="bill-tab" data-kind="income">收入账单</button>
  <button role="tab" class="bill-tab" data-kind="expense">支出账单</button>
  <button role="tab" class="bill-tab" data-kind="tax">涉税信息报送账单</button>
</nav>
<div class="segment" id="segment"></div>
<div>月份 * <span class="wn-date-picker2-input-range"><input class="wn-input" value="${escapeHtml(month)}"><input class="wn-input" value="${escapeHtml(month)}"></span></div>
<button id="query">查询</button>
<button id="exportPdf">导出PDF</button>
<button id="exportExcel">导出Excel</button>
<a id="exportCenter" href="/export-center">历史下载记录</a>
<div id="resultArea">请选择账单类型并查询</div>
<table id="billTable" style="display:none"><thead><tr><th>日期</th><th>收入总额</th><th>退款金额</th><th>收入净额</th></tr></thead><tbody></tbody></table>
<script>
(function(){
  var account = ${JSON.stringify(account)};
  var subtypes = ${JSON.stringify(SUBTYPES)};
  var kind = ${JSON.stringify(kind)};
  var queried = false;
  var segment = document.getElementById('segment');
  var result = document.getElementById('resultArea');
  function monthValue(){ var inputs = document.querySelectorAll('.wn-date-picker2-input-range input'); return inputs.length ? inputs[0].value : ''; }
  document.getElementById('noticeClose').addEventListener('click', function(){ document.getElementById('noticeLayer').style.display = 'none'; });
  document.getElementById('exportPdf').addEventListener('click', function(){ result.textContent = '已选择 PDF 导出（取账单不使用 PDF）'; });
  function renderSegment(){
    segment.innerHTML = subtypes[kind].map(function(s,i){ return '<button class="segment-item"'+(i===0?' data-active="1"':'')+'>'+s+'</button>'; }).join('');
  }
  function currentSubtype(){ var el = segment.querySelector('.segment-item[data-active="1"]'); return el ? el.textContent : subtypes[kind][0]; }
  segment.addEventListener('click', function(e){
    var button = e.target.closest('.segment-item'); if(!button) return;
    Array.prototype.forEach.call(segment.querySelectorAll('.segment-item'), function(item){ item.removeAttribute('data-active'); });
    button.setAttribute('data-active','1'); queried = false; result.textContent = '筛选条件已改变，请重新查询';
  });
  document.getElementById('billTabs').addEventListener('click', function(e){
    var button = e.target.closest('.bill-tab'); if(!button) return;
    kind = button.dataset.kind; queried = false; renderSegment();
    result.textContent = '已切换到 ' + kind + '，请查询';
    document.getElementById('billTable').style.display = 'none';
  });
  document.getElementById('query').addEventListener('click', function(){
    var month = monthValue();
    if (!month) { result.textContent = '请选择账期'; return; }
    queried = true;
    if (location.search.indexOf('empty=1') >= 0) { result.textContent = '当前查询条件下数据为空'; document.getElementById('billTable').style.display='none'; return; }
    result.textContent = '共 2 条记录（' + month + ' ' + kind + ' ' + currentSubtype() + '）';
    var body = document.querySelector('#billTable tbody');
    body.innerHTML = '<tr><td>' + month + '-01</td><td>105.00</td><td>5.00</td><td>100.00</td></tr><tr><td>' + month + '-05</td><td>110.00</td><td>10.00</td><td>100.00</td></tr>';
    document.getElementById('billTable').style.display = '';
  });
  document.getElementById('exportExcel').addEventListener('click', function(){
    if (!queried) { result.textContent = '请先查询再导出'; return; }
    var month = monthValue();
    var subtype = currentSubtype();
    var query = '?account=' + encodeURIComponent(account) + '&kind=' + kind + '&month=' + month + '&subtype=' + encodeURIComponent(subtype);
    if (kind === 'tax') {
      result.textContent = '已提交导出申请，请在历史下载记录查看';
      fetch('/export-task' + query).then(function(){ result.textContent = '导出申请已提交，请在历史下载记录下载'; });
      return;
    }
    result.textContent = '正在导出 ' + month + ' ' + subtype;
    var link = document.createElement('a');
    link.href = '/download' + query;
    link.setAttribute('download', '');
    link.style.display = 'none';
    document.body.appendChild(link);
    // 锚点保留在 DOM 里：点完立刻移除有可能把已经发起的下载一起取消掉（会表现为偶发收不到文件）。
    setTimeout(function(){ link.click(); }, 30);
  });
  renderSegment();
})();
</script>
</body></html>`;

const exportCenterPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>历史下载记录 - 千牛财务</title>
<style>body{font:14px/1.6 system-ui;margin:0;padding:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 12px}</style></head>
<body><h1>历史下载记录</h1><table id="tasks"><thead><tr><th>账期</th><th>账单类型</th><th>子类型</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody></table>
<script>
(function(){
  function load(){
    fetch('/export-tasks').then(function(r){return r.json();}).then(function(tasks){
      var body = document.querySelector('#tasks tbody');
      body.innerHTML = tasks.map(function(task){
        var action = task.ready
          ? '<a href="/download-task?id=' + task.id + '" download>下载</a>'
          : '生成中，请稍后';
        return '<tr><td>' + task.month + '</td><td>' + task.kindLabel + '</td><td>' + task.subtype + '</td><td>' + (task.ready ? '已完成' : '生成中') + '</td><td>' + action + '</td></tr>';
      }).join('') || '<tr><td>暂无导出任务</td><td></td><td></td><td></td><td></td></tr>';
    });
  }
  load(); setInterval(load, 500);
})();
</script></body></html>`;

const loginPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>千牛工作台 - 商家一站式经营阵地</title></head>
<body><p>关于千牛</p><p>欢迎登录做生意上千牛</p><button>密码登录</button><button>短信登录</button><button>扫码登录</button></body></html>`;

/**
 * 启动仿真服务。
 * @param {object} [options]
 * @param {number} [options.port] 0 表示随机端口
 * @param {number} [options.taskDelayMs] 异步导出任务生成耗时
 */
export async function startQianniuFixture({ port = 0, taskDelayMs = 600 } = {}) {
  const tasks = [];
  let counter = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, type, body) => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); response.end(body); };
    const sendFile = async (query, name) => {
      const buffer = await buildBillBuffer({ subtype: query.get('subtype') || '全部', kind: query.get('kind') || 'income', amount: 100 + ((query.get('subtype') || '').length * 7) + ((query.get('kind') || '').length * 3) });
      // 中文文件名必须按 RFC 5987 用 filename* 传，否则浏览器拿到的是被百分号编码的“文件名”，
      // 既不是真实文件名，也让后续按文件名判断的逻辑失去意义。
      response.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="bill.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'content-length': buffer.length
      });
      response.end(buffer);
    };
    // 多账号并发验证用：写入 / 读取会话 Cookie，用来证明不同店铺窗口之间登录态互相隔离。
    if (url.pathname === '/set-cookie') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': `qn_account=${encodeURIComponent(url.searchParams.get('account') || '')}; Path=/` });
      return response.end('ok');
    }
    if (url.pathname === '/whoami') {
      const cookie = String(request.headers.cookie || '');
      const matched = cookie.match(/qn_account=([^;]*)/);
      return send(200, 'text/plain; charset=utf-8', decodeURIComponent(matched ? matched[1] : ''));
    }
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', loginPage());
    if (url.pathname === '/login') return send(200, 'text/html; charset=utf-8', loginPage());
    if (url.pathname === '/bill') {
      return send(200, 'text/html; charset=utf-8', billPage({ account: url.searchParams.get('account') || 'unknown-shop', kind: url.searchParams.get('kind') || 'income', month: url.searchParams.get('month') || new Date().toISOString().slice(0, 7) }));
    }
    if (url.pathname === '/export-center') return send(200, 'text/html; charset=utf-8', exportCenterPage());
    if (url.pathname === '/export-task') {
      const id = `task-${++counter}`;
      tasks.push({ id, account: url.searchParams.get('account') || '', kind: url.searchParams.get('kind') || 'tax', kindLabel: KIND_LABELS[url.searchParams.get('kind')] || '涉税信息报送账单', month: url.searchParams.get('month') || '2026-09', subtype: url.searchParams.get('subtype') || '全部', readyAt: Date.now() + taskDelayMs });
      return send(200, 'application/json', JSON.stringify({ ok: true, id }));
    }
    if (url.pathname === '/export-tasks') {
      return send(200, 'application/json', JSON.stringify(tasks.map(task => ({ ...task, ready: Date.now() >= task.readyAt, readyAt: undefined }))));
    }
    if (url.pathname === '/download') {
      const subtype = url.searchParams.get('subtype') || '全部';
      return sendFile(url.searchParams, `${KIND_LABELS[url.searchParams.get('kind')] || '账单'}-${url.searchParams.get('month')}-${subtype}.xlsx`);
    }
    if (url.pathname === '/download-task') {
      const task = tasks.find(item => item.id === url.searchParams.get('id'));
      if (!task || Date.now() < task.readyAt) return send(404, 'text/html; charset=utf-8', '<html><body>任务尚未生成</body></html>');
      return sendFile(new URLSearchParams({ kind: task.kind, subtype: task.subtype }), `${task.kindLabel}-${task.month}-${task.subtype}.xlsx`);
    }
    if (url.pathname === '/broken') return send(200, 'text/html; charset=utf-8', '<!doctype html><html><body>登录已失效，请重新登录</body></html>');
    return send(404, 'text/html; charset=utf-8', '<html><body>未找到页面</body></html>');
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    tasks,
    close: () => new Promise(resolve => server.close(resolve))
  };
}
