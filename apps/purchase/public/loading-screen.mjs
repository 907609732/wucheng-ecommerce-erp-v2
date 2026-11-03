/** Shared presentation only: callers own request lifecycle, progress and errors. */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

export function loadingMarkup({
  variant = 'content',
  brand = '五成电商工作台',
  subtitle = '',
  status = '正在加载…',
  note = '',
  logo = '../assets/lingtu-icon.png',
  id = '',
  module = '',
  state = 'loading',
  progress
} = {}) {
  const mode = ['full', 'content', 'inline'].includes(variant) ? variant : 'content';
  const label = status || '正在加载…';
  const hint = note || '正在准备所需内容，请稍候。';
  const measured=Number.isFinite(progress?.value)&&Number.isFinite(progress?.total)&&progress.total>0&&progress.value>=0&&progress.value<=progress.total;
  return `<div class="lt-loading" data-variant="${mode}" data-module="${escapeHtml(module)}" data-state="${escapeHtml(state)}"${id ? ` id="${escapeHtml(id)}"` : ''} role="status" aria-live="polite" aria-busy="${state!=='ready'}">
  <div class="lt-loading__logo"><img src="${escapeHtml(logo)}" alt="" draggable="false"></div>
  <div class="lt-loading__brand">${escapeHtml(brand)}</div>
  <div class="lt-loading__subtitle"${subtitle ? '' : ' hidden'}>${escapeHtml(subtitle)}</div>
  <progress class="lt-loading__progress"${measured?` value="${progress.value}" max="${progress.total}"`:''} aria-label="${escapeHtml(label)}"></progress>
  <div class="lt-loading__status">${escapeHtml(label)}</div>
  <div class="lt-loading__note">${escapeHtml(hint)}</div>
</div>`;
}
