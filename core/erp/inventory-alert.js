export const INVENTORY_ALERT_LABELS = Object.freeze({
  critical: "🔴 不够卖 1 周",
  urgent: "🟠 不够卖 2 周",
  warning: "🟡 不够卖 1 月",
  ok: "🟢 正常"
});

export function calculateInventoryAvailability({ totalQuantity, monthlyOutbound, near30DaysSales }) {
  const quantity = Number(totalQuantity || 0);
  const monthlySales = Number(monthlyOutbound || 0);
  const recentSales = Number(near30DaysSales || 0);
  const dailyOutbound = recentSales > 0 ? recentSales / 30 : monthlySales > 0 ? monthlySales / 30 : 0;
  const sellableDays = dailyOutbound > 0 ? quantity / dailyOutbound : Infinity;

  let stockAlert = { level: "ok", text: "", days: sellableDays };
  if (sellableDays < 7) {
    stockAlert = { level: "critical", text: "不够卖一星期，严重缺货无法发货", days: sellableDays };
  } else if (sellableDays < 15) {
    stockAlert = { level: "urgent", text: "不够卖半个月，急需补货", days: sellableDays };
  } else if (sellableDays < 30) {
    stockAlert = { level: "warning", text: "不够卖一个月，需要补货", days: sellableDays };
  }

  return { dailyOutbound, sellableDays, stockAlert };
}

export function inventoryAlertLabel(level) {
  return INVENTORY_ALERT_LABELS[level] || INVENTORY_ALERT_LABELS.ok;
}
