const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function shiftMonth(month, offset) {
  assertMonth(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + Number(offset || 0), 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function latestCompleteMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return shiftMonth(`${year}-${String(month).padStart(2, "0")}`, -1);
}

export function defaultBackfillRange(now = new Date(), monthCount = 24) {
  const to = latestCompleteMonth(now);
  return { from: shiftMonth(to, -(Math.max(1, monthCount) - 1)), to };
}

export function buildMonthlySalesDashboard({
  rows = [],
  validations = [],
  year = "",
  selectedMonth = "",
  scope = "overall",
  seriesMode = "top5",
  sku = "",
  now = new Date()
} = {}) {
  const latestMonth = latestCompleteMonth(now);
  const validMonths = new Set(validations.filter((item) => item.status === "valid").map((item) => String(item.month)));
  const allMonths = [...new Set([
    ...rows.map((item) => String(item.month || "")),
    ...validations.map((item) => String(item.month || ""))
  ].filter((month) => MONTH_PATTERN.test(month)))].sort();
  const years = [...new Set(allMonths.map((month) => month.slice(0, 4)))].sort();
  const selectedYear = /^\d{4}$/.test(String(year))
    ? String(year)
    : (years.at(-1) || latestMonth.slice(0, 4));
  if (!years.includes(selectedYear)) years.push(selectedYear);
  years.sort();
  const months = Array.from({ length: 12 }, (_, index) => `${selectedYear}-${String(index + 1).padStart(2, "0")}`);
  const effectiveMonth = MONTH_PATTERN.test(String(selectedMonth)) && String(selectedMonth).startsWith(`${selectedYear}-`)
    ? String(selectedMonth)
    : ([...months].reverse().find((month) => validMonths.has(month)) || `${selectedYear}-12`);

  const normalizedRows = rows.map((item) => ({
    month: String(item.month || ""),
    sku: String(item.sku || ""),
    productName: String(item.productName || item.product_name || item.sku || ""),
    tocSales: Number(item.tocSales ?? item.toc_sales ?? 0),
    tobSales: Number(item.tobSales ?? item.tob_sales ?? 0),
    salesQuantity: Number(item.salesQuantity ?? item.sales_quantity ?? 0)
  })).filter((item) => MONTH_PATTERN.test(item.month) && item.sku);

  const skuMap = new Map();
  for (const row of normalizedRows) {
    if (!skuMap.has(row.sku)) skuMap.set(row.sku, { sku: row.sku, productName: row.productName, byMonth: new Map() });
    const item = skuMap.get(row.sku);
    item.productName = row.productName || item.productName;
    item.byMonth.set(row.month, row);
  }
  const skuOptions = [...skuMap.values()].map(({ sku: itemSku, productName }) => ({ sku: itemSku, productName }))
    .sort((a, b) => a.productName.localeCompare(b.productName, "zh-CN") || a.sku.localeCompare(b.sku, "zh-CN"));

  const overallByMonth = new Map();
  for (const row of normalizedRows) {
    const total = overallByMonth.get(row.month) || { tocSales: 0, tobSales: 0, salesQuantity: 0 };
    total.tocSales += row.tocSales;
    total.tobSales += row.tobSales;
    total.salesQuantity += row.salesQuantity;
    overallByMonth.set(row.month, total);
  }

  const seriesFor = (itemSku, name, productName = "") => {
    const monthly = months.map((month) => {
      if (!validMonths.has(month)) return null;
      const value = itemSku === "__overall__" ? overallByMonth.get(month) : skuMap.get(itemSku)?.byMonth.get(month);
      // A validated month exists even when a particular SKU has no outbound row.
      // That means zero sales for the SKU, while a month without validation stays null.
      return value ? Number(value.salesQuantity) : 0;
    });
    const annual = years.map((itemYear) => {
      const yearMonths = Array.from({ length: 12 }, (_, index) => `${itemYear}-${String(index + 1).padStart(2, "0")}`);
      const coverage = yearMonths.filter((month) => validMonths.has(month)).length;
      const values = yearMonths.map((month) => {
        if (!validMonths.has(month)) return null;
        const value = itemSku === "__overall__" ? overallByMonth.get(month) : skuMap.get(itemSku)?.byMonth.get(month);
        return value ? Number(value.salesQuantity) : 0;
      }).filter((value) => value != null);
      return { year: itemYear, value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, validMonthCount: coverage, complete: coverage === 12 };
    });
    return { sku: itemSku, name, productName, monthly, annual };
  };

  const overallSeries = seriesFor("__overall__", "全店总销量", "全部商品");
  const selectedSku = String(sku || "").trim();
  const selectedItem = skuMap.get(selectedSku);
  const selectedSeries = selectedItem ? seriesFor(selectedItem.sku, selectedItem.productName || selectedItem.sku, selectedItem.productName) : null;
  const rankedItems = [...skuMap.values()].map((item) => ({
    ...item,
    yearTotal: months.reduce((sum, month) => sum + Number(item.byMonth.get(month)?.salesQuantity || 0), 0)
  })).sort((a, b) => b.yearTotal - a.yearTotal || a.sku.localeCompare(b.sku, "zh-CN"));
  const top5Series = rankedItems.slice(0, 5).map((item) => seriesFor(item.sku, item.productName || item.sku, item.productName));
  const top10Series = rankedItems.slice(0, 10).map((item) => seriesFor(item.sku, item.productName || item.sku, item.productName));
  const allSeries = rankedItems.map((item) => seriesFor(item.sku, item.productName || item.sku, item.productName));

  const previousMonth = shiftMonth(effectiveMonth, -1);
  const canCompareDecline = validMonths.has(effectiveMonth) && validMonths.has(previousMonth);
  const decliningItems = canCompareDecline
    ? [...skuMap.values()].map((item) => {
        const currentSales = Number(item.byMonth.get(effectiveMonth)?.salesQuantity || 0);
        const previousSales = Number(item.byMonth.get(previousMonth)?.salesQuantity || 0);
        return { ...item, currentSales, previousSales, decline: previousSales - currentSales };
      }).filter((item) => item.decline > 0)
        .sort((a, b) => b.decline - a.decline || b.previousSales - a.previousSales || a.sku.localeCompare(b.sku, "zh-CN"))
        .slice(0, 10)
    : [];
  const decliningSeries = decliningItems.map((item) => seriesFor(item.sku, item.productName || item.sku, item.productName));
  const normalizedSeriesMode = ["top5", "top10", "all", "decliners"].includes(seriesMode) ? seriesMode : "top5";
  const multiSeries = normalizedSeriesMode === "top10"
    ? top10Series
    : normalizedSeriesMode === "all"
      ? allSeries
      : normalizedSeriesMode === "decliners"
        ? decliningSeries
        : top5Series;

  const multiScope = scope === "multi" || scope === "top5";
  const chartSeries = multiScope
    ? (scope === "top5" ? top5Series : multiSeries)
    : scope === "sku" && selectedSeries
      ? [overallSeries, selectedSeries]
      : [overallSeries];
  const primarySeries = scope === "sku" && selectedSeries ? selectedSeries : overallSeries;
  const presentValues = primarySeries.monthly.map((value, index) => ({ month: months[index], value })).filter((item) => item.value != null);
  const totalSales = presentValues.reduce((sum, item) => sum + item.value, 0);
  const peak = [...presentValues].sort((a, b) => b.value - a.value)[0] || null;

  const ranking = [...skuMap.values()].map((item) => {
    const current = item.byMonth.get(effectiveMonth);
    const previous = item.byMonth.get(previousMonth);
    const currentValue = current ? Number(current.salesQuantity) : null;
    const previousValue = previous ? Number(previous.salesQuantity) : null;
    return {
      sku: item.sku,
      productName: item.productName,
      tocSales: current ? Number(current.tocSales) : null,
      tobSales: current ? Number(current.tobSales) : null,
      salesQuantity: currentValue,
      previousSalesQuantity: previousValue,
      mom: currentValue == null || previousValue == null || previousValue === 0 ? null : (currentValue - previousValue) / previousValue
    };
  }).filter((item) => item.salesQuantity != null)
    .sort((a, b) => b.salesQuantity - a.salesQuantity || a.sku.localeCompare(b.sku, "zh-CN"));

  return {
    available: allMonths.length > 0 && validMonths.size > 0,
    latestCompleteMonth: latestMonth,
    dueMonth: validMonths.has(latestMonth) ? "" : latestMonth,
    defaultBackfill: defaultBackfillRange(now, 24),
    years,
    selectedYear,
    selectedMonth: effectiveMonth,
    months,
    skuOptions,
    scope: multiScope ? "multi" : scope === "sku" ? "sku" : "overall",
    seriesMode: scope === "top5" ? "top5" : normalizedSeriesMode,
    seriesContext: normalizedSeriesMode === "decliners"
      ? { fromMonth: previousMonth, toMonth: effectiveMonth, comparable: canCompareDecline, itemCount: decliningSeries.length }
      : { itemCount: multiSeries.length },
    selectedSku,
    summary: {
      label: primarySeries.name,
      totalSales,
      averageSales: presentValues.length ? totalSales / presentValues.length : null,
      peakMonth: peak?.month || "",
      peakSales: peak?.value ?? null,
      validMonthCount: months.filter((month) => validMonths.has(month)).length,
      incomplete: months.filter((month) => validMonths.has(month)).length !== 12
    },
    overallSeries,
    selectedSeries,
    top5Series,
    top10Series,
    allSeries,
    decliningSeries,
    chartSeries,
    ranking,
    coverage: years.map((itemYear) => ({
      year: itemYear,
      validMonthCount: Array.from({ length: 12 }, (_, index) => `${itemYear}-${String(index + 1).padStart(2, "0")}`).filter((month) => validMonths.has(month)).length
    }))
  };
}

function assertMonth(month) {
  if (!MONTH_PATTERN.test(String(month || ""))) throw new Error(`月份格式无效：${month || "空"}`);
}
