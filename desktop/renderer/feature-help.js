(() => {
  'use strict';
  const content = window.erpFeatureHelpContent;
  const dialog = document.getElementById('featureHelpDialog');
  const body = document.getElementById('featureHelpBody');
  const title = document.getElementById('featureHelpTitle');
  const manual = document.getElementById('featureManualButton');
  const modeButtons = [...document.querySelectorAll('[data-feature-help-mode]')];
  let currentView = 'home';
  let helpView = 'home';
  let helpMode = 'manual';
  let opener = null;

  function render() {
    const guide = content[helpView];
    title.textContent = `${guide.title} · ${helpMode === 'manual' ? '说明书' : '技术原理'}`;
    dialog.dataset.view = helpView;
    dialog.dataset.mode = helpMode;
    modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.featureHelpMode === helpMode)));
    body.replaceChildren();
    const intro = document.createElement('p');
    intro.className = 'feature-help-intro';
    intro.textContent = guide.summary;
    body.append(intro);
    for (const section of guide[helpMode]) {
      const container = document.createElement('section');
      if (section.warning) container.className = 'feature-help-warning';
      const heading = document.createElement('h3');
      heading.textContent = section.title;
      const list = document.createElement(section.ordered ? 'ol' : 'ul');
      for (const text of section.items) {
        const item = document.createElement('li');
        item.textContent = text;
        list.append(item);
      }
      container.append(heading, list);
      body.append(container);
    }
    const sources = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = '说明依据 / 维护入口';
    const list = document.createElement('ul');
    for (const source of guide.sources) {
      const item = document.createElement('li');
      item.textContent = source;
      list.append(item);
    }
    sources.append(heading, list);
    body.append(sources);
    body.scrollTop = 0;
  }

  function open(mode = 'manual', view = currentView) {
    if (!Object.hasOwn(content, view)) view = 'home';
    helpView = view;
    helpMode = mode === 'principle' ? 'principle' : 'manual';
    if (!dialog.open) opener = document.activeElement;
    render();
    if (!dialog.open) dialog.showModal();
  }

  manual.addEventListener('click', () => open('manual'));
  document.getElementById('featureHelpClose').addEventListener('click', () => dialog.close());
  modeButtons.forEach(button => button.addEventListener('click', () => open(button.dataset.featureHelpMode, helpView)));
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
  window.addEventListener('erp:view', event => {
    currentView = Object.hasOwn(content, event.detail) ? event.detail : 'home';
    const name = content[currentView].title;
    manual.title = `${name} · 使用说明与技术原理`;
    if (dialog.open) open(helpMode, currentView);
  });
  window.erpFeatureHelp = Object.freeze({ open });
})();
