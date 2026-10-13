import ExcelJS from 'exceljs';

const labels = { pdd: '拼多多' };
const yuan = value => Number.isSafeInteger(value) ? value / 100 : '待核对';
const optional = value => value == null ? '未提供' : yuan(value);
const safeText = value => String(value ?? '');
export async function exportPddOrders(orders, file, { imageLoader, includeTrackingNumber = false } = {}) {
  if (!Array.isArray(orders)) throw new Error('采购订单列表无效');
  const workbook = new ExcelJS.Workbook(); workbook.creator = '五成电子商务集团 ERP';
  const sheet = workbook.addWorksheet('采购订单'), details = workbook.addWorksheet('商品规格');
  const orderHeaders = ['月份', '平台', '账号', '订单号', '下单时间', '付款时间', '供应商', '整单实付款', '运费', '优惠', '退款金额', '状态', '商品规格', '备注', '待核对事项', '图片附件'];
  if (includeTrackingNumber) orderHeaders.push('快递单号');
  sheet.addRow(orderHeaders);
  details.addRow(['月份', '平台', '账号', '订单号', '商品', '规格/SKU', '数量', '单位', '单价', '商品金额', '商品备注']);
  const imageWarnings = [], imageCache = new Map(); let itemCount = 0, imageCount = 0;
  for (const order of orders) {
    const items = order.items || [];
    const row = sheet.addRow([safeText(order.month), labels[order.platform] || safeText(order.platform), safeText(order.account), safeText(order.orderId), safeText(order.orderedAt), safeText(order.paidAt), safeText(order.supplier), yuan(order.amountCents), optional(order.freightCents), optional(order.discountCents), optional(order.refundCents), safeText(order.status), items.map((item, index) => `${index + 1}. ${safeText(item.item)} · ${safeText(item.sku)} · ${item.quantity ?? '未提供'}${item.unit || ''}`).join('\n'), safeText(order.note), (order.issues || []).join('\n'), (order.attachments || []).map(image => image.label || '图片').join('\n')]);
    row.getCell(4).numFmt = '@';
    if (includeTrackingNumber) { row.getCell(17).value = safeText(order.attributes?.trackingNumber || order.trackingNumber || order.attributes?.['快递单号']); row.getCell(17).numFmt = '@'; }
    for (const column of [8, 9, 10, 11]) row.getCell(column).numFmt = '#,##0.00';
    row.height = Math.max(28, items.length * 16);
    for (const item of items) {
      const line = details.addRow([safeText(order.month), labels[order.platform] || safeText(order.platform), safeText(order.account), safeText(order.orderId), safeText(item.item), safeText(item.sku), item.quantity ?? '未提供', safeText(item.unit), optional(item.unitPriceCents), optional(item.itemAmountCents), safeText(item.note)]);
      line.getCell(4).numFmt = '@'; line.getCell(9).numFmt = '#,##0.00'; line.getCell(10).numFmt = '#,##0.00'; itemCount++;
    }
    let slot = 0;
    for (const attachment of order.attachments || []) {
      try {
        if (!imageLoader) throw new Error('缺少安全图片读取器');
        const image = await imageLoader({ orderId: order.id, attachmentId: attachment.id });
        const match = image?.dataUrl?.match(/^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) throw new Error('导出图片格式不支持');
        let imageId = imageCache.get(image.dataUrl);
        if (imageId == null) { imageId = workbook.addImage({ base64: image.dataUrl, extension: match[1] }); imageCache.set(image.dataUrl, imageId); }
        sheet.addImage(imageId, { tl: { col: 15, row: row.number - 1 + slot * 0.01 }, ext: { width: 120, height: 90 }, editAs: 'oneCell' });
        // Multiple attachments share the image column, positioned in separate rows within a tall order row.
        const media = sheet.getImages().at(-1); media.range.tl.nativeRowOff = slot * 96 * 9525;
        row.height = Math.max(row.height, (slot + 1) * 96 * 0.75); slot++; imageCount++;
      } catch (error) { imageWarnings.push({ orderId: order.orderId, attachmentId: attachment.id, message: error.message }); }
    }
  }
  for (const page of [sheet, details]) {
    page.views = [{ state: 'frozen', ySplit: 1 }]; page.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: page.columnCount } };
    page.getRow(1).font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF245D3F' } };
    page.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4F0E8' } }; page.getRow(1).height = 28;
    page.eachRow((row, index) => { if (index > 1) row.font = { name: 'Microsoft YaHei', size: 10 }; row.alignment = { vertical: 'middle', wrapText: true }; });
    page.columns.forEach(column => { column.width = 18; }); page.getColumn(4).width = 27;
  }
  sheet.getColumn(7).width = 30; sheet.getColumn(13).width = 48; sheet.getColumn(15).width = 40; sheet.getColumn(16).width = 20;
  details.getColumn(5).width = 45; details.getColumn(6).width = 35;
  await workbook.xlsx.writeFile(file);
  return { file, orderCount: orders.length, itemCount, imageCount, imageWarnings };
}
