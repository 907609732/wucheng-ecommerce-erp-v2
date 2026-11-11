const publicPrefix = typeof location !== 'undefined' ? location.pathname.match(/^(\/app\/wuchengerp(?:trial)?)\/web\//)?.[1] || '' : '';
const API = publicPrefix + '/api/workbench/v1/data-versions';
const modules = { purchase: '采购', sales: '销售', overview: '经营总览' };

export function statusInfo(value) {
  const statuses = { submitted: { label: '已托管', tone: 'submitted' }, failed: { label: '托管异常', tone: 'failed' }, pending: { label: '等待托管', tone: 'pending' }, uploading: { label: '正在托管', tone: 'pending' } };
  return Object.hasOwn(statuses, value) ? statuses[value] : { label: '等待确认', tone: 'pending' };
}
export function displayChangeset(event) {
  const value = String(event.changeset ?? '');
  return event.status === 'submitted' && /^(?:cs:)?\d+$/.test(value) ? `cs:${value.replace(/^cs:/, '')}` : '—';
}
export function displayCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number).toLocaleString('zh-CN') : '0';
}
export function attachmentName(attachment) { return attachment.name || attachment.path || '附件'; }
export function hostingError(code) {
  const explanations = {
    UVCS_UNAVAILABLE: '云端托管服务暂不可用，请稍后重试。',
    UVCS_TIMEOUT: '云端托管请求超时，请稍后刷新状态或重试。',
    UVCS_CHANGESET_UNCONFIRMED: '远端提交尚未确认，系统会核对后再显示提交号。',
    UVCS_CONFIG_INVALID: '托管配置不可用，请联系运维检查。',
    UVCS_WORKSPACE_REPOSITORY_MISMATCH: '托管工作区与目标仓库不一致，请联系运维检查。',
    UVCS_EVENT_LOOKUP_INVALID: '远端版本查询结果无法确认，请联系运维检查。',
    UVCS_OUTPUT_LIMIT: '托管服务响应超出允许范围，请联系运维检查。',
    DATA_VERSION_WORKSPACE_DIRTY: '托管工作区存在待处理变更，请联系运维检查。',
    DATA_VERSION_EVENT_CHANGED: '版本事件校验异常，请联系运维修复后再托管。',
    DATA_VERSION_HASH_MISMATCH: '版本文件校验不一致，请联系运维修复后再托管。',
    DATA_VERSION_PATH_INVALID: '版本文件位置校验未通过，请联系运维检查。',
    DATA_VERSION_INVALID_EVENT: '版本事件内容校验未通过，请联系运维检查。',
    DATA_VERSION_SNAPSHOT_UNAVAILABLE: '版本快照暂不可读取，请联系运维检查。',
    DATA_VERSION_SOURCE_UNAVAILABLE: '版本记录来源暂不可读取，请联系运维检查。',
    DATA_VERSION_LOCK_UNAVAILABLE: '托管服务正在处理其他任务，请稍后重试。',
    DATA_VERSION_CONFIG_INVALID: '数据版本配置不可用，请联系运维检查。',
    DATA_VERSION_FILTER_INVALID: '查询条件无效，请调整日期或筛选条件后重试。',
    DATA_VERSION_CLOSED: '托管服务已停止，请稍后刷新或联系运维。'
  };
  return Object.hasOwn(explanations, code) ? explanations[code] : '托管暂未完成，请稍后重试；持续异常时请联系运维检查。';
}
export function listQuery(filters, offset = 0) {
  const query = new URLSearchParams({ limit: '50', offset: String(offset) });
  for (const key of ['module', 'actor', 'status']) if (filters[key]) query.set(key, filters[key].trim());
  for (const key of ['from', 'to']) {
    if (!filters[key]) continue;
    const date = new Date(`${filters[key]}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}`);
    if (!Number.isNaN(date.getTime())) query.set(key, date.toISOString());
  }
  return query;
}
function time(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text != null) result.textContent = String(text);
  if (className) result.className = className;
  return result;
}
function badge(value) {
  const status = statusInfo(value);
  return node('span', status.label, `badge ${status.tone}`);
}

if (typeof document !== 'undefined') {
  const $ = (selector) => document.querySelector(selector);
  const filters = $('#filters'), dialog = $('#detail');
  let offset = 0, total = 0, timer, listController, detailController, currentId, opener, retrying = false, destroyed = false;
  let filterValues = {};
  async function request(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.message || data.error;
      throw Error(/^(?:DATA_VERSION_|UVCS_)[A-Z_]+$/.test(message || '') ? hostingError(message) : message || `请求失败（${response.status}）`);
    }
    return data;
  }
  function notice(text, error = false) {
    $('#notice').textContent = text;
    $('#notice').classList.toggle('error', error);
  }
  function renderSummary(summary) {
    for (const key of ['pending', 'failed', 'submitted']) $(`#${key}-count`).textContent = displayCount(summary[key]);
    $('#summary-note').textContent = summary.enabled
      ? `业务保存与托管独立进行，无需重复保存。最近托管：${time(summary.lastSubmittedAt)}`
      : '当前未启用数据版本托管。业务保存状态请以业务台提示为准。';
  }
  function renderList(items) {
    const body = $('#records');
    body.replaceChildren();
    for (const event of items) {
      const row = node('tr');
      const values = [event.summary || event.action || '业务保存', time(event.createdAt), event.actor?.label || event.actor?.id || '系统', modules[event.module] || event.module || '—', badge(event.status), displayChangeset(event)];
      const labels = ['业务摘要', '发生时间', '操作人', '模块', '托管状态', '提交号'];
      values.forEach((value, index) => {
        const cell = node('td');
        cell.dataset.label = labels[index];
        if (value instanceof Node) cell.append(value); else cell.textContent = String(value);
        row.append(cell);
      });
      const cell = node('td'), button = node('button', '查看详情', 'view');
      button.type = 'button';
      button.setAttribute('aria-label', `查看版本详情：${event.summary || event.action || '业务保存'}`);
      button.addEventListener('click', () => openDetail(event.id, button));
      cell.append(button); row.append(cell); body.append(row);
    }
    $('#empty').hidden = items.length !== 0;
    $('#total').textContent = total ? `共 ${total} 条 · 第 ${Math.floor(offset / 50) + 1} 页` : '共 0 条';
    $('#previous').disabled = offset === 0;
    $('#next').disabled = offset + 50 >= total;
  }
  function schedule() {
    clearTimeout(timer);
    if (!destroyed && !document.hidden) timer = setTimeout(() => void load(), 30000);
  }
  async function load() {
    clearTimeout(timer);
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    $('#refresh').disabled = true;
    notice('正在读取版本记录…');
    try {
      const [summaryResult, listResult] = await Promise.allSettled([
        request(`${API}/summary`, { signal: controller.signal }),
        request(`${API}?${listQuery(filterValues, offset)}`, { signal: controller.signal })
      ]);
      if (listController !== controller || document.hidden || destroyed) return;
      if (summaryResult.status === 'fulfilled') renderSummary(summaryResult.value);
      else {
        for (const key of ['pending', 'failed', 'submitted']) $(`#${key}-count`).textContent = '—';
        $('#summary-note').textContent = `托管状态查询失败：${summaryResult.reason.message}`;
      }
      if (listResult.status === 'rejected') throw listResult.reason;
      total = Number(listResult.value.total || 0);
      renderList(listResult.value.items || []);
      notice(summaryResult.status === 'fulfilled' ? '版本记录仅展示保存与托管进度。查看历史不会修改正式业务数据。' : '记录已读取，但当前托管概况无法确认。', summaryResult.status !== 'fulfilled');
    } catch (error) {
      if (listController !== controller || document.hidden || destroyed) return;
      notice(`版本记录读取失败，现有列表可能已过期：${error.name === 'AbortError' ? '请求超时，请刷新重试' : error.message}。这不代表业务保存失败。`, true);
    } finally {
      clearTimeout(timeout);
      if (listController === controller) { $('#refresh').disabled = false; schedule(); }
    }
  }
  function field(list, label, value) { list.append(node('dt', label), node('dd', value ?? '—')); }
  function renderDetail(event) {
    const content = $('#detail-content');
    content.replaceChildren(node('p', event.summary || event.action || '业务保存', 'detail-summary'), badge(event.status));
    const list = node('dl');
    field(list, '事件 ID', event.id);
    field(list, '发生时间', time(event.createdAt));
    field(list, '操作人', event.actor?.label || event.actor?.id || '系统');
    field(list, '模块', modules[event.module] || event.module);
    field(list, '业务操作', event.action);
    field(list, '提交号', displayChangeset(event));
    field(list, '远端提交时间', event.status === 'submitted' ? time(event.submittedAt) : '尚未确认');
    field(list, '托管尝试', event.attempts ?? 0);
    content.append(list);
    const counts = event.counts || {};
    content.append(node('p', `新增 ${displayCount(counts.insert)} 条 · 修改 ${displayCount(counts.update)} 条 · 删除 ${displayCount(counts.delete)} 条`, 'counts'));
    content.append(node('p', '以上为业务记录变化数量，附件摘要用于核验文件，不代表文件内容差异。', 'detail-note'));
    content.append(node('h3', '附件清单'));
    if (event.attachments?.length) {
      const attachments = node('ul', null, 'attachment-list');
      for (const attachment of event.attachments) {
        const item = node('li', attachmentName(attachment));
        item.append(node('span', `${displayCount(attachment.bytes)} 字节`, 'attachment-meta'));
        item.append(node('span', `SHA-256：${attachment.sha256 || '—'}`, 'attachment-meta'));
        attachments.append(item);
      }
      content.append(attachments);
    } else content.append(node('p', '此版本无附件。', 'detail-note'));
    $('#retry-hosting').hidden = event.status !== 'failed';
    if (event.status === 'failed') {
      content.append(node('h3', '托管异常'));
      content.append(node('p', hostingError(event.error), 'detail-note'));
      content.append(node('p', '业务已保存，不必重复保存业务。后台会自动重试，也可手动重试托管。', 'detail-note'));
    }
  }
  async function openDetail(id, button) {
    detailController?.abort();
    currentId = id; opener = button || opener;
    $('#detail-content').replaceChildren(node('p', '正在读取版本详情…'));
    $('#retry-message').textContent = '';
    $('#retry-hosting').hidden = true;
    if (!dialog.open) dialog.showModal();
    const controller = new AbortController(); detailController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const event = await request(`${API}/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (dialog.open && detailController === controller) renderDetail(event);
    } catch (error) {
      if (dialog.open && detailController === controller) $('#detail-content').replaceChildren(node('p', `详情读取失败：${error.name === 'AbortError' ? '请求超时' : error.message}`));
    } finally { clearTimeout(timeout); }
  }
  $('#retry-hosting').addEventListener('click', async () => {
    if (retrying || !currentId) return;
    retrying = true;
    const id = currentId, controller = new AbortController();
    detailController?.abort(); detailController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    $('#retry-hosting').disabled = true;
    $('#retry-message').classList.remove('error');
    $('#retry-message').textContent = '正在请求重试托管…';
    try {
      const session = await request(publicPrefix+'/api/workbench/v1/session', { signal: controller.signal });
      if (!session.csrfToken) throw Error('会话已失效，请刷新后重试');
      await request(`${API}/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: { 'x-workbench-csrf': session.csrfToken }, signal: controller.signal });
      if (dialog.open && currentId === id) { await openDetail(id); $('#retry-message').textContent = '已请求重试，远端确认后才会显示已托管。'; }
      void load();
    } catch (error) {
      if (dialog.open && currentId === id) {
        $('#retry-message').textContent = `重试结果暂未确认：${error.name === 'AbortError' ? '请求超时，请刷新状态' : error.message}。不必重复保存业务。`;
        $('#retry-message').classList.add('error');
      }
    } finally { clearTimeout(timeout); retrying = false; $('#retry-hosting').disabled = false; }
  });
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(filters));
    if (values.from && values.to && values.from > values.to) return notice('开始日期不能晚于结束日期。', true);
    filterValues = values; offset = 0; void load();
  });
  $('#reset-filters').addEventListener('click', () => { filters.reset(); filterValues = {}; offset = 0; void load(); });
  $('#refresh').addEventListener('click', () => { void load(); if (dialog.open && !retrying) void openDetail(currentId); });
  $('#previous').addEventListener('click', () => { offset = Math.max(0, offset - 50); void load(); });
  $('#next').addEventListener('click', () => { offset += 50; void load(); });
  $('#close-detail').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { detailController?.abort(); currentId = null; if (opener?.isConnected) opener.focus(); });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) { listController?.abort(); detailController?.abort(); }
    else { void load(); if (dialog.open && !retrying) void openDetail(currentId); }
  });
  window.addEventListener('pagehide', () => { destroyed = true; clearTimeout(timer); listController?.abort(); detailController?.abort(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { destroyed = false; void load(); } });
  if (!document.hidden) void load();
}
