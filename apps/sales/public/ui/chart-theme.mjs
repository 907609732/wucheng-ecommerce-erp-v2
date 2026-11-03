/** Resolve a design token for canvas APIs that cannot consume CSS var() directly. */
export function themeColor(name) {
  const value=getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if(!value)throw new Error(`Missing UI color token: ${name}`);
  return value;
}
export function chartPalette() {
  return ['--lt-chart-1','--lt-chart-2','--lt-chart-3','--lt-chart-4','--lt-chart-5','--lt-chart-6','--lt-chart-7'].map(themeColor);
}
/** Apply the local CSS contract to Chart.js; call before creating charts. */
export function applyChartDefaults(Chart, scale = 1) {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('scale must be positive');
  const style = getComputedStyle(document.documentElement);
  const read = name => {
    const value = style.getPropertyValue(name).trim();
    if (!value) throw new Error(`Missing chart token: ${name}`);
    return value;
  };
  const palette = ['--lt-chart-1','--lt-chart-2','--lt-chart-3','--lt-chart-4','--lt-chart-5','--lt-chart-6','--lt-chart-7'].map(read);
  const defaults = Chart.defaults;
  defaults.font.family = read('--lt-font');
  defaults.font.size = 11 * scale;
  defaults.color = read('--lt-chart-axis');
  defaults.borderColor = read('--lt-line');
  defaults.plugins.tooltip = {
    ...defaults.plugins.tooltip,
    backgroundColor:read('--lt-chart-tooltip'), padding:12,
    titleFont:{...defaults.plugins.tooltip?.titleFont,size:12 * scale},
    bodyFont:{...defaults.plugins.tooltip?.bodyFont,size:11 * scale}
  };
  // Chart.js supports indexable color defaults; explicit per-chart options still win.
  defaults.backgroundColor = palette;
  defaults.datasets.bar = {...defaults.datasets.bar, backgroundColor:read('--lt-chart-bar-muted')};
  defaults.datasets.doughnut = {...defaults.datasets.doughnut, backgroundColor:palette};
  defaults.datasets.pie = {...defaults.datasets.pie, backgroundColor:palette};
  for (const type of ['category','linear']) {
    const axis = defaults.scales[type];
    if (axis) {
      axis.ticks = {...axis.ticks, color:read('--lt-chart-axis'),font:{...axis.ticks?.font,size:11 * scale}};
      axis.grid = {...axis.grid,color:read('--lt-line')};
    }
  }
  // Empty rings have no Chart.js default; expose their contract to the consumer.
  return {palette, mutedBar:read('--lt-chart-bar-muted'), emptyRing:read('--lt-chart-empty')};
}
