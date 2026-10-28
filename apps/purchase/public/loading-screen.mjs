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
  id = ''
} = {}) {
  const mode = ['full', 'content', 'inline'].includes(variant) ? variant : 'content';
  const label = status || '正在加载…';
  const hint = note || '正在准备所需内容，请稍候。';
  return `<div class="lt-loading" data-variant="${mode}"${id ? ` id="${escapeHtml(id)}"` : ''} role="status" aria-live="polite" aria-busy="true">
  <div class="lt-loading__logo"><img src="${escapeHtml(logo)}" alt="" draggable="false"></div>
  <div class="lt-loading__brand">${escapeHtml(brand)}</div>
  <div class="lt-loading__subtitle"${subtitle ? '' : ' hidden'}>${escapeHtml(subtitle)}</div>
  <progress class="lt-loading__progress" aria-label="${escapeHtml(label)}"></progress>
  <div class="lt-loading__status">${escapeHtml(label)}</div>
  <div class="lt-loading__note">${escapeHtml(hint)}</div>
</div>`;
}
